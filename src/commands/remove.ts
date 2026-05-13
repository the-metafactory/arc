import { join } from "path";
import { rm, lstat, readlink, unlink } from "fs/promises";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { ArcPaths, HostAdapter } from "../types.js";
import { getSkill, removeSkill, listByLibrary } from "../lib/db.js";
import { removeSymlink, removeCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks, hasHooks } from "../lib/hooks.js";
import { findGitRoot } from "../lib/paths.js";
import { unwireExtensions } from "../lib/extensions.js";
import { runScript } from "../lib/scripts.js";

export interface RemoveOptions {
  /** Suppress interactive prompts / informational output (for non-interactive / test use). */
  yes?: boolean;
}

export interface RemoveResult {
  success: boolean;
  name?: string;
  error?: string;
  removedCount?: number;
}

/**
 * Completely remove an installed skill.
 *
 * Mirrors `install` in reverse:
 *  1. Fire `scripts.preremove` (if declared) so the package can stop daemons
 *     and clean up host-side state (launchd plists, etc.) BEFORE its repo +
 *     symlinks are torn down. See arc#138.
 *  2. Tear down primary symlink (skill/agent/tool/...) and CLI shims.
 *  3. Remove hooks from settings.json and unwire extensions.
 *  4. Reverse-iterate `provides.files` and unlink each target IFF it is a
 *     symlink pointing at the source we installed (hand-edited files are
 *     left in place with a warning).
 *  5. Delete the DB row and the cloned repo directory.
 */
export async function remove(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: RemoveOptions = {}
): Promise<RemoveResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, error: `Skill '${name}' is not installed` };
  }

  // Read manifest up-front. Needed for preremove firing, provides.files
  // cleanup, CLI shim names, and hooks teardown. Best-effort: if the manifest
  // is unreadable (corrupted clone, manual rm -rf, etc.) we fall through with
  // a null manifest and skip the manifest-driven cleanup steps — the DB row
  // and primary symlink will still be removed.
  const manifest = await readManifest(skill.install_path).catch(() => null);

  // 1. Fire preremove script BEFORE anything is torn down. Same shape as
  //    preinstall/preupgrade — gives the package a chance to stop daemons,
  //    unload launchd plists, etc. while its files and symlinks still exist.
  //    Missing script falls through silently via runScript's skipped path.
  if (manifest?.scripts?.preremove) {
    const preResult = runScript({
      installPath: skill.install_path,
      scriptPath: manifest.scripts.preremove,
      hookName: "preremove",
      quiet: opts.yes,
    });
    if (!preResult.success && !preResult.skipped) {
      // Do NOT abort: a failing preremove (e.g. daemon already stopped) must
      // not block the user from finishing the cleanup. Warn loudly instead.
      console.warn(
        `  ⚠ preremove script exited ${preResult.exitCode}; continuing remove anyway`,
      );
    }
  }

  const isTool = skill.artifact_type === "tool";
  const isAgent = skill.artifact_type === "agent";
  const isPrompt = skill.artifact_type === "prompt";
  const isPipeline = skill.artifact_type === "pipeline";
  const isAction = skill.artifact_type === "action";

  if (isAction) {
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

  // Remove hooks from settings.json (before deleting repo)
  if (hasHooks(manifest?.provides?.hooks)) {
    const settingsPath = host.paths.settingsPath;
    await removeHooks(name, settingsPath);
  }

  // Remove extensions (before deleting repo)
  if (manifest?.extensions) {
    await unwireExtensions(manifest, host.paths.root);
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
  } catch (err: any) {
    if (err?.code === "ENOENT") return; // already gone, nothing to do
    console.warn(`  ⚠ provides.files cleanup: cannot stat ${targetPath}: ${err?.message ?? err}`);
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
  } catch (err: any) {
    console.warn(`  ⚠ provides.files cleanup: readlink failed on ${targetPath}: ${err?.message ?? err}`);
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
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`  ⚠ provides.files cleanup: unlink failed on ${targetPath}: ${err?.message ?? err}`);
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
