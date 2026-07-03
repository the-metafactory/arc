import { join } from "path";
import { rm, lstat, readlink, unlink } from "fs/promises";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type {
  ArcManifest,
  ArcPaths,
  HostAdapter,
  HostId,
} from "../types.js";
import { getSkill, removeSkill, listByLibrary } from "../lib/db.js";
import { removeSymlink, removeCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks } from "../lib/hooks.js";
import { findGitRoot } from "../lib/paths.js";
import { unwireExtensions } from "../lib/extensions.js";
import { runLifecycleScripts, runScript } from "../lib/scripts.js";
import { runSomaSkillProjection } from "../lib/soma-projection.js";
import {
  type HostOverrides,
  orderTargetsForInstall,
  resolveHost,
} from "../lib/hosts/registry.js";
import { removeLaunchdArtifacts } from "../lib/hosts/launchd-install.js";
import { isDarwinLaunchdHost } from "../lib/hosts/darwin-launchd.js";
import { errorMessage, isErrno } from "../lib/errors.js";

export interface RemoveResult {
  success: boolean;
  name?: string;
  error?: string;
  removedCount?: number;
}

export interface RemoveOptions {
  /** Suppress interactive prompts / informational output (arc#138). */
  yes?: boolean;
  /**
   * Suppress console output (for non-interactive / test use). Passed
   * through to lifecycle script runs.
   */
  quiet?: boolean;
  /**
   * Per-host adapter overrides for multi-target removes (arc#140 P5).
   * Mirrors `InstallOptions.hostOverrides`.
   */
  hostOverrides?: HostOverrides;
}

/**
 * Run the preuninstall phase (arc#140 P5): `scripts.preuninstall` (single
 * script) first, then `lifecycle.preuninstall` (ordered array). The arc#140
 * design (cortex `docs/design-arc-agent-bots.md` §8.3) requires
 * preuninstall scripts to fire BEFORE any symlinks are removed — typical
 * sequence is launchctl unload → drain → signal cortex reload, all of
 * which need the agent fragment + binary still on disk.
 *
 * Symmetric to runPreinstallPhase / runPostinstallPhase in install.ts.
 * On any script failure the function returns the error string; caller
 * decides whether to abort the uninstall. Per the design doc's
 * D7 ("abort-on-revoke-failure"), arc remove aborts to avoid leaving
 * phantom state — the operator can investigate and retry.
 */
function runPreuninstallPhase(
  installPath: string,
  manifest: ArcManifest | null,
  quiet?: boolean,
): { success: true } | { success: false; error: string } {
  if (!manifest) return { success: true };

  const lifecycle = manifest.lifecycle?.preuninstall;
  if (lifecycle && lifecycle.length > 0) {
    const result = runLifecycleScripts({
      installPath,
      scriptPaths: lifecycle,
      phase: "preuninstall",
      quiet,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Preuninstall lifecycle script failed: ${result.failedAt} (exit ${result.steps.at(-1)?.exitCode ?? "?"})`,
      };
    }
  }

  return { success: true };
}

/**
 * Run the postuninstall phase (arc#140 P5): `lifecycle.postuninstall`
 * (ordered array). Fires AFTER symlinks + plist + binary are removed,
 * so it's safe for scripts that signal cortex to re-read agents.d/
 * (which is now empty of this bot).
 *
 * Failures in postuninstall do NOT roll the uninstall back (the
 * artifacts are already gone) — they're surfaced to the operator
 * as warnings.
 */
function runPostuninstallPhase(
  installPath: string,
  manifest: ArcManifest | null,
  quiet?: boolean,
): { success: true } | { success: false; error: string } {
  if (!manifest) return { success: true };

  const lifecycle = manifest.lifecycle?.postuninstall;
  if (lifecycle && lifecycle.length > 0) {
    const result = runLifecycleScripts({
      installPath,
      scriptPaths: lifecycle,
      phase: "postuninstall",
      quiet,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Postuninstall lifecycle script failed: ${result.failedAt} (exit ${result.steps.at(-1)?.exitCode ?? "?"})`,
      };
    }
  }

  return { success: true };
}

/**
 * Multi-target uninstall walk (arc#140 P5).
 *
 * Reverses the install ordering: supervision hosts (darwin-launchd,
 * linux-systemd) FIRST so the daemon stops and releases its NATS
 * connection BEFORE the registry-side fragment is removed (per cortex
 * `docs/design-arc-agent-bots.md` §8.3 "revoke creds BEFORE removing
 * files").
 *
 * For each target:
 *   - darwin-launchd → removeLaunchdArtifacts (plist + binary symlink)
 *   - cortex / claude-code → remove the type-appropriate artifact
 *     symlink from that host's directory
 *
 * Errors are best-effort: a missing artifact on one target does not
 * abort the others. Non-ENOENT errors surface via console.warn.
 */
async function removePerTarget(opts: {
  targets: HostId[];
  manifest: ArcManifest;
  packageName: string;
  hostOverrides?: HostOverrides;
  quiet?: boolean;
}): Promise<void> {
  const reverseOrder = [...orderTargetsForInstall(opts.targets)].reverse();

  for (const targetId of reverseOrder) {
    const targetHost = resolveHost(targetId, opts.hostOverrides);

    if (targetId === "darwin-launchd") {
      // Sage P3 review (arc#143): type guard instead of blanket cast.
      if (!isDarwinLaunchdHost(targetHost)) {
        if (!opts.quiet) {
          console.warn(
            `  ⚠ Skipping darwin-launchd remove: adapter did not expose plistDir`,
          );
        }
        continue;
      }
      await removeLaunchdArtifacts({
        host: targetHost,
        manifest: opts.manifest,
        quiet: opts.quiet,
      });
      continue;
    }

    if (targetId === "linux-systemd") {
      // arc#140 P6: matched install-side behavior — the adapter exists
      // but remove dispatch isn't yet wired. Skip with a warning rather
      // than aborting; the operator can clean up manually.
      if (!opts.quiet) {
        console.warn(
          `  ⚠ Skipping linux-systemd remove: dispatch not yet implemented (arc#140 Phase C)`,
        );
      }
      continue;
    }

    // registry hosts (cortex, claude-code): unlink the type-conventional
    // artifact symlink from this host's directory. Same per-type dispatch
    // as the single-host path below — factored so the inline reuses it.
    await removeArtifactFromHost(
      opts.manifest.type,
      opts.packageName,
      targetHost,
    );

    // provides.files (e.g. cortex's <name>.md fragment) — unlink each
    // declared target path.
    for (const f of opts.manifest.provides?.files ?? []) {
      const home = process.env.HOME ?? "";
      const target = f.target.replace(/^~/, home);
      await removeSymlink(target);
    }
  }
}

/**
 * Remove the type-conventional artifact symlink from one host adapter.
 *
 * Pulled out of the legacy single-host remove path so both that path
 * and {@link removePerTarget} share the same per-type unlink logic.
 */
async function removeArtifactFromHost(
  type: ArcManifest["type"],
  name: string,
  host: HostAdapter,
): Promise<void> {
  switch (type) {
    case "agent": {
      const mdLink = join(host.paths.agentsDir, `${name}.md`);
      const dirLink = join(host.paths.agentsDir, name);
      if (!(await removeSymlink(mdLink))) {
        await removeSymlink(dirLink);
      }
      return;
    }
    case "prompt": {
      const mdLink = join(host.paths.promptsDir, `${name}.md`);
      const dirLink = join(host.paths.promptsDir, name);
      if (!(await removeSymlink(mdLink))) {
        await removeSymlink(dirLink);
      }
      return;
    }
    case "tool": {
      const binLink = join(host.paths.binDir, name);
      await removeSymlink(binLink);
      return;
    }
    case "skill":
    case "system":
    case "component":
    case "rules":
    case "library":
    case "pipeline":
    default: {
      const skillLink = join(host.paths.skillsDir, name);
      await removeSymlink(skillLink);
      return;
    }
  }
}

/**
 * Completely remove an installed skill.
 *
 * Mirrors `install` in reverse:
 *  1. Fire `scripts.preremove` (if declared, arc#138) so the package can
 *     stop daemons and clean up host-side state BEFORE its repo + symlinks
 *     are torn down. Failures here warn but do not abort.
 *  2. arc#140 P5: run `lifecycle.preuninstall` array (in declared order).
 *     The bot's daemon needs the binary + creds in place to drain/unload.
 *     Per design doc §10.1 D7, a failure here ABORTS the remove (phantom
 *     state is worse than refusing the operation).
 *  3. For packages declaring `targets:` (standalone-bot agents): walk each
 *     target's artifacts in REVERSE install order (supervision hosts FIRST,
 *     registry hosts LAST).
 *  4. Otherwise: tear down primary symlink (skill/agent/tool/…).
 *  5. CLI shims, hooks, extensions cleanup.
 *  6. Reverse-iterate `provides.files` and unlink each target IFF it is a
 *     symlink pointing at the source we installed (arc#138 safety).
 *  7. Delete the DB row.
 *  8. arc#140 P5: run `lifecycle.postuninstall` array. Failures warn only.
 *  9. Delete the cloned repo directory.
 */
export async function remove(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, error: `Skill '${name}' is not installed` };
  }

  // Read manifest up-front. Needed for preremove firing, lifecycle scripts,
  // provides.files cleanup, CLI shim names, and hooks teardown. Best-effort:
  // if the manifest is unreadable (corrupted clone, manual rm -rf), fall
  // through with a null manifest — DB row and primary symlink still removed.
  const manifest = await readManifest(skill.install_path).catch(() => null);

  // 1. Fire scripts.preremove (arc#138) — non-aborting on failure.
  if (manifest?.scripts?.preremove) {
    const preResult = runScript({
      installPath: skill.install_path,
      scriptPath: manifest.scripts.preremove,
      hookName: "preremove",
      quiet: opts.yes === true || opts.quiet === true,
    });
    if (!preResult.success && !preResult.skipped) {
      console.warn(
        `  ⚠ preremove script exited ${preResult.exitCode}; continuing remove anyway`,
      );
    }
  }

  // 2. arc#140 P5: lifecycle.preuninstall array — ABORTS on failure (D7).
  const preuninstallResult = runPreuninstallPhase(
    skill.install_path,
    manifest,
    opts.quiet ?? opts.yes,
  );
  if (!preuninstallResult.success) {
    return { success: false, error: preuninstallResult.error };
  }

  const isTool = skill.artifact_type === "tool";
  const isAgent = skill.artifact_type === "agent";
  const isPrompt = skill.artifact_type === "prompt";
  const isPipeline = skill.artifact_type === "pipeline";
  const isAction = skill.artifact_type === "action";

  // Multi-target path (arc#140 P5): walk targets in reverse install order.
  // No-op when manifest is missing (we still try to clean DB/repo below).
  if (manifest?.targets && manifest.targets.length > 0) {
    await removePerTarget({
      targets: manifest.targets,
      manifest,
      packageName: name,
      hostOverrides: opts.hostOverrides,
      quiet: opts.quiet,
    });
  } else if (isAction) {
    // Actions: remove action symlink
    const actionLink = join(arc.actionsDir, name);
    await removeSymlink(actionLink);
  } else if (isPipeline) {
    // Pipelines: remove pipeline symlink
    const pipelineLink = join(arc.pipelinesDir, name);
    await removeSymlink(pipelineLink);
  } else if (isTool) {
    // Tools: remove bin symlink (repo root linked to binDir)
    const binLink = join(host.paths.binDir, name);
    await removeSymlink(binLink);
  } else if (isAgent) {
    // Agents: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(host.paths.agentsDir, `${name}.md`);
    const dirLink = join(host.paths.agentsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else if (isPrompt) {
    // Prompts: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(host.paths.promptsDir, `${name}.md`);
    const dirLink = join(host.paths.promptsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else {
    // Skills: remove skill symlink
    const skillLink = join(host.paths.skillsDir, name);
    await removeSymlink(skillLink);
  }

  // Remove all CLI shims and bin symlinks (skills and tools)
  if (!isAgent && !isPrompt && manifest) {
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      await removeCliShim(arc.shimDir, entry.binName);
      await removeSymlink(join(host.paths.binDir, entry.binName));
    }
    if (!cliEntries.length) {
      // Fallback: remove by conventional name
      const fallbackName = isTool ? name.toLowerCase() : name.replace(/^_/, "").toLowerCase();
      await removeCliShim(arc.shimDir, fallbackName);
      await removeSymlink(join(host.paths.binDir, fallbackName));
    }
  }

  // Remove hooks from settings.json (before deleting repo).
  //
  // arc#137: always invoke removeHooks regardless of manifest state.
  // The filter inside removeHooks keys on the `_pai_pkg` tag written at
  // install time, so it's safe (and idempotent) to call when the source
  // repo was deleted out-of-band and the manifest no longer parses.
  // Gating on `manifest?.provides?.hooks` was wrong: a missing or
  // unreadable manifest left settings.json entries pointing at paths
  // that no longer exist, surfacing as "No such file or directory"
  // errors on every Claude Code session start.
  await removeHooks(name, host.paths.settingsPath);

  // Remove extensions (before deleting repo)
  if (manifest?.extensions) {
    await unwireExtensions(manifest, host.paths.root);
  }

  if (manifest?.type === "skill") {
    const somaProjectionResult = await runSomaSkillProjection({
      manifest,
      installPath: skill.install_path,
      mode: "unproject",
    });
    if (somaProjectionResult.warning && opts.quiet !== true) {
      process.stderr.write(
        `  ⚠ ${somaProjectionResult.warning}; continuing without Soma projection\n`,
      );
    }
  }

  // Mirror provides.files on the way out.
  //
  // For every {source, target} the installer created, unlink the target IFF
  // it is still a symlink AND it points at the source path we installed.
  //
  // Safety rule: never `rm` a target that has been hand-edited (i.e. it's
  // a regular file now, or its symlink target no longer matches). The
  // operator may have replaced an arc-installed file with their own copy;
  // arc has no business deleting that. Warn instead. See arc#138.
  if (manifest?.provides?.files?.length) {
    for (const file of manifest.provides.files) {
      const expectedSource = join(skill.install_path, file.source);
      const targetPath = file.target.replace(/^~/, homedir());
      await removeProvidedFile(targetPath, expectedSource);
    }
  }

  // Remove from database (CASCADE deletes capabilities) — before repo removal
  removeSkill(db, name);

  // arc#140 P5: run postuninstall lifecycle scripts AFTER artifacts are gone
  // — typical use is to signal cortex reload so the AgentRegistry rebuilds
  // without this agent. Failures here are surfaced as warnings (the
  // uninstall itself already succeeded; the artifacts are no longer on disk).
  if (manifest) {
    const postuninstallResult = runPostuninstallPhase(
      skill.install_path,
      manifest,
      opts.quiet,
    );
    if (!postuninstallResult.success && !opts.quiet) {
      console.warn(`  ⚠ ${postuninstallResult.error}`);
    }
  }

  // Remove repo directory — but NOT if other library artifacts still reference it
  if (skill.library_name) {
    const siblings = listByLibrary(db, skill.library_name);
    if (siblings.length === 0) {
      // Last artifact from this library — safe to remove the entire repo clone
      // The repo clone is the parent of install_path for library artifacts
      // install_path points to the artifact subdir, so we need the library root
      const repoRoot = findGitRoot(skill.install_path);
      if (repoRoot) {
        await rm(repoRoot, { recursive: true, force: true });
      }
    }
    // If siblings remain, leave the repo clone in place
  } else {
    // Standalone package — remove repo directory as before
    await rm(skill.install_path, { recursive: true, force: true });
  }

  return { success: true, name };
}

/**
 * Remove a single provides.files target.
 *
 * Only unlinks if the path is a symlink pointing at `expectedSource`. Any
 * other state — regular file, missing entry, symlink to something else — is
 * left untouched and surfaced via a console warning so an operator who has
 * deliberately customised the file isn't ambushed.
 */
async function removeProvidedFile(
  targetPath: string,
  expectedSource: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(targetPath);
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return; // already gone, nothing to do
    console.warn(`  ⚠ provides.files cleanup: cannot stat ${targetPath}: ${errorMessage(err)}`);
    return;
  }

  if (!stat.isSymbolicLink()) {
    console.warn(
      `  ⚠ provides.files cleanup: ${targetPath} is not a symlink (skipped — leave it for the operator to inspect)`,
    );
    return;
  }

  let actualTarget: string;
  try {
    actualTarget = await readlink(targetPath);
  } catch (err) {
    console.warn(`  ⚠ provides.files cleanup: readlink failed on ${targetPath}: ${errorMessage(err)}`);
    return;
  }

  if (actualTarget !== expectedSource) {
    console.warn(
      `  ⚠ provides.files cleanup: ${targetPath} points to ${actualTarget}, not ${expectedSource} (skipped)`,
    );
    return;
  }

  try {
    await unlink(targetPath);
  } catch (err) {
    if (isErrno(err) && err.code !== "ENOENT") {
      console.warn(`  ⚠ provides.files cleanup: unlink failed on ${targetPath}: ${errorMessage(err)}`);
    }
  }
}

/**
 * Remove all artifacts belonging to a library package.
 * Falls back from artifact lookup to library lookup.
 */
export async function removeLibrary(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  libraryName: string,
  opts: RemoveOptions = {}
): Promise<RemoveResult> {
  const artifacts = listByLibrary(db, libraryName);
  if (!artifacts.length) {
    return {
      success: false,
      error: `Package '${libraryName}' is not installed (checked as both artifact and library)`,
    };
  }

  const results: RemoveResult[] = [];
  for (const artifact of artifacts) {
    const result = await remove(db, arc, host, artifact.name, opts);
    results.push(result);
  }

  const removedCount = results.filter((r) => r.success).length;
  const allSuccess = results.every((r) => r.success);
  return {
    success: allSuccess,
    name: libraryName,
    removedCount,
  };
}
