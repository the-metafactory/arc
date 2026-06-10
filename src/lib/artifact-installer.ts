import { join, dirname } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type {
  ArtifactType,
  ArcManifest,
  ArcPaths,
  HostAdapter,
  LibraryArtifactEntry,
} from "../types.js";
import { errorMessage, isErrno } from "./errors.js";
import {
  createSymlink,
  createCliShim,
  extractAllCliInfo,
  removeSymlink,
  removeCliShim,
} from "./symlinks.js";
import { generateRules } from "./rules.js";
import { requireHostDir } from "./hosts/dispatch.js";

/**
 * Maps an artifact type to its conventional source subdirectory within a cloned repo.
 *
 * - rules, component, tool -> baseDir (no subdirectory)
 * - pipeline -> join(baseDir, "pipeline") if it exists, else baseDir
 * - agent -> join(baseDir, "agent")
 * - prompt -> join(baseDir, "prompt")
 * - skill (default) -> join(baseDir, "skill")
 */
export function resolveArtifactSourceDir(type: ArtifactType | "rules" | "system", baseDir: string): string {
  switch (type) {
    case "action":
    case "rules":
    case "component":
    case "tool":
      return baseDir;

    case "pipeline": {
      const pipelineDir = join(baseDir, "pipeline");
      return existsSync(pipelineDir) ? pipelineDir : baseDir;
    }

    case "agent":
      return join(baseDir, "agent");

    case "prompt":
      return join(baseDir, "prompt");

    case "skill":
    case "system":
    default:
      return join(baseDir, "skill");
  }
}

/**
 * Create symlinks for an installed artifact based on its type.
 *
 * Handles all artifact types: rules (template generation), pipeline, component,
 * tool, agent, prompt, and skill. Extracted from install() to allow reuse
 * across install, catalog use, and single-artifact install flows.
 */
/**
 * Aggregate of every filesystem artifact a single createArtifactSymlinks call
 * created. Captured so a downstream failure (hook gate, post-install script,
 * etc.) can roll back the partial state — see issue #89.
 */
export interface ArtifactSymlinkRecord {
  /** Absolute paths of symlinks created (any directory). */
  symlinks: string[];
  /** CLI shim files created via createCliShim (need removeCliShim, not unlink). */
  shims: { dir: string; names: string[] };
}

export async function createArtifactSymlinks(opts: {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Target host adapter. Defaults to Claude-Code in the caller. */
  host: HostAdapter;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}): Promise<{
  filesCreated: { source: string; target: string }[];
  filesMissingSource: { source: string; target: string }[];
  record: ArtifactSymlinkRecord;
}> {
  const { type, manifest, arc, host, installDir, quiet } = opts;
  const record: ArtifactSymlinkRecord = { symlinks: [], shims: { dir: arc.shimDir, names: [] } };

  // Helper that wraps createSymlink + tracks the target for rollback (#89).
  const linkTracked = async (source: string, target: string) => {
    await createSymlink(source, target);
    record.symlinks.push(target);
  };
  const shimTracked = async () => {
    const created = await createCliShim(arc.shimDir, host.paths.binDir, manifest);
    record.shims.names.push(...created);
  };

  // Pre-validation pass (#89): assert every provides.files source exists in
  // the package before we create ANY symlinks. The most common failure mode
  // (manifest typo, repo drift) is now stopped with zero filesystem mutation,
  // so install can return cleanly without producing orphan symlinks.
  const declaredFiles = manifest.provides?.files ?? [];
  const filesMissingSource: { source: string; target: string }[] = [];
  for (const file of declaredFiles) {
    const sourcePath = join(installDir, file.source);
    if (!existsSync(sourcePath)) {
      filesMissingSource.push({
        source: sourcePath,
        target: file.target.replace(/^~/, homedir()),
      });
    }
  }
  if (filesMissingSource.length) {
    return { filesCreated: [], filesMissingSource, record };
  }

  switch (type) {
    case "action": {
      // Actions: symlink action directory into actionsDir
      const actionLinkPath = join(arc.actionsDir, manifest.name);
      await linkTracked(installDir, actionLinkPath);
      break;
    }

    case "rules": {
      // Rules packages: run template generation in the consumer repo
      const templates = manifest.provides?.templates ?? [];
      if (templates.length) {
        const consumerDir = opts.consumerDir ?? process.cwd();
        const results = await generateRules(installDir, templates, consumerDir);
        if (!quiet) {
          for (const r of results) {
            if (r.success && r.target) {
              console.log(`  Generated ${r.target}`);
            } else if (!r.success) {
              console.log(`  \u26A0 ${r.target}: ${r.error}`);
            }
          }
        }
      }
      break;
    }

    case "pipeline": {
      // Pipelines: symlink repo root (or pipeline/ subdirectory) to pipelinesDir.
      // pipelinesDir is arc state (host-independent) — pipelines aren't host-installed.
      const pipelineSourceDir = join(installDir, "pipeline");
      const sourceDir = existsSync(pipelineSourceDir) ? pipelineSourceDir : installDir;
      const pipelineLinkPath = join(arc.pipelinesDir, manifest.name);
      await linkTracked(sourceDir, pipelineLinkPath);

      // If the manifest declares CLI entries, the bin shims still go through
      // the host (binDir is per-host).
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(host.paths.binDir, entry.binName);
        await linkTracked(installDir, binLinkPath);
      }
      if (cliEntries.length) {
        await shimTracked();
      }
      break;
    }

    case "component": {
      // Components have no per-type primary layout — provides.files is honored
      // by the type-agnostic pass below.
      break;
    }

    case "tool": {
      // Tools: symlink repo root to the host's binDir for each CLI entry.
      const binDir = requireHostDir(host, "tool");
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(binDir, entry.binName);
        await linkTracked(installDir, binLinkPath);
      }
      if (!cliEntries.length) {
        // Fallback: symlink under manifest name if no CLI declared
        await linkTracked(installDir, join(binDir, manifest.name));
      }

      // Create PATH-accessible shims for all CLI entries
      await shimTracked();
      break;
    }

    case "agent": {
      // Agents: symlink the .md file directly into agentsDir for auto-discovery.
      const agentsDir = requireHostDir(host, "agent");
      const agentSourceDir = join(installDir, "agent");
      const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      const linkPath = join(agentsDir, mdFile);

      if (existsSync(sourcePath)) {
        await linkTracked(sourcePath, linkPath);
      } else {
        // Fallback: symlink directory if .md file not found by convention name
        await linkTracked(sourceDir, join(agentsDir, manifest.name));
      }
      break;
    }

    case "prompt": {
      // Prompts: symlink the .md file directly into promptsDir for auto-discovery.
      const promptsDir = requireHostDir(host, "prompt");
      const promptSourceDir = join(installDir, "prompt");
      const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      const linkPath = join(promptsDir, mdFile);

      if (existsSync(sourcePath)) {
        await linkTracked(sourcePath, linkPath);
      } else {
        // Fallback: symlink directory if .md file not found by convention name
        await linkTracked(sourceDir, join(promptsDir, manifest.name));
      }
      break;
    }

    case "skill":
    case "system": {
      // Skills: symlink skill/ subdirectory (or root) to the host's skillsDir.
      const skillsDir = requireHostDir(host, type);
      const skillSourceDir = join(installDir, "skill");
      const skillLinkPath = join(skillsDir, manifest.name);

      if (existsSync(skillSourceDir)) {
        await linkTracked(skillSourceDir, skillLinkPath);
      } else {
        await linkTracked(installDir, skillLinkPath);
      }

      // CLI symlinks + shims only when the skill declares CLI entries.
      // The binDir lookup must stay inside this guard so a future adapter
      // that supports skills but exposes no bin directory still installs
      // pure-content skills cleanly.
      const cliEntries = extractAllCliInfo(manifest);
      if (cliEntries.length) {
        const binDir = requireHostDir(
          host,
          "tool",
          "expose a bin directory for skill CLIs",
        );
        for (const entry of cliEntries) {
          const binLinkPath = join(binDir, entry.binName);
          await linkTracked(installDir, binLinkPath);
        }
        await shimTracked();
      }
      break;
    }

    default: {
      // Library is unwound at install.ts:181 before reaching this dispatch;
      // any other value is a programming bug, not a user-facing error.
      throw new Error(
        `Unsupported artifact type "${type as string}" in createArtifactSymlinks`,
      );
    }
  }

  // Type-agnostic provides.files pass.
  // Every artifact type honors provides.files entries — used to ship auxiliary
  // files (hook handlers, helpers, shared libs) alongside the primary layout.
  // Previously only `component` honored this, which silently broke any
  // multi-artifact package using a different primary type. See issue #84.
  // The pre-validation pass above guarantees every source exists by the time
  // we get here, so we can fearlessly create symlinks without partial-state risk.
  const filesCreated: { source: string; target: string }[] = [];
  for (const file of declaredFiles) {
    const sourcePath = join(installDir, file.source);
    const targetPath = file.target.replace(/^~/, homedir());
    await mkdir(dirname(targetPath), { recursive: true });
    await linkTracked(sourcePath, targetPath);
    filesCreated.push({ source: sourcePath, target: targetPath });
  }

  return { filesCreated, filesMissingSource: [], record };
}

/**
 * Roll back every symlink and shim recorded by createArtifactSymlinks.
 *
 * Called by install on:
 *   - Hook-validation gate failure (issue #89): symlinks placed but hooks
 *     not yet registered. Caller only needs this helper.
 *   - Postinstall-script failure (issue #97): symlinks AND hooks both placed
 *     before the script ran, so the caller pairs this with removeHooks
 *     before returning. recordInstall hasn't happened yet at that point,
 *     so no DB row to clean up.
 *
 * Best-effort across all entries: an ENOENT on one path doesn't abort
 * cleanup of the others. Non-ENOENT errors (e.g. permission denied) are
 * surfaced via console.warn so the user sees orphans they need to inspect
 * manually rather than failing silently.
 */
export async function rollbackArtifactSymlinks(record: ArtifactSymlinkRecord): Promise<void> {
  for (const link of record.symlinks) {
    try {
      await removeSymlink(link);
    } catch (err) {
      if (!isErrno(err) || err.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove symlink ${link}: ${errorMessage(err)}`);
      }
    }
  }
  for (const name of record.shims.names) {
    try {
      await removeCliShim(record.shims.dir, name);
    } catch (err) {
      if (!isErrno(err) || err.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove shim ${name}: ${errorMessage(err)}`);
      }
    }
  }
}

/**
 * Run bun install if package.json exists in the given directory.
 */
export function installNodeDependencies(dir: string): void {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    Bun.spawnSync(["bun", "install"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}

/**
 * Parse a "library:artifact" colon-separated reference.
 *
 * Returns null if the ref looks like a URL (contains "/") rather than a library ref.
 * If there's no colon, returns { libraryName: ref } indicating the whole library.
 *
 * Examples:
 *   "mylib:tool-a"  -> { libraryName: "mylib", artifactName: "tool-a" }
 *   "mylib"         -> { libraryName: "mylib" }
 *   "https://..."   -> null (URL, not a library ref)
 *   "org/repo"      -> null (URL-like path)
 */
export function parseLibraryRef(ref: string): { libraryName: string; artifactName?: string } | null {
  // URLs contain "/" — not a library ref
  if (ref.includes("/")) {
    return null;
  }

  const colonIndex = ref.indexOf(":");
  if (colonIndex === -1) {
    // No colon: whole library
    return { libraryName: ref };
  }

  const libraryName = ref.slice(0, colonIndex);
  const artifactName = ref.slice(colonIndex + 1);

  if (!libraryName) {
    return null;
  }

  return { libraryName, artifactName: artifactName || undefined };
}

/** A library artifact paired with its manifest, as read by readLibraryArtifacts. */
export interface ArtifactEntry {
  entry: LibraryArtifactEntry;
  manifest: ArcManifest;
}

/**
 * Topologically sort a library's artifacts by `depends_on.packages`.
 *
 * F-6c (arc#227): library installs must land each artifact AFTER the artifacts
 * it depends on, so that e.g. `pilot` (depends_on agent-state) installs only
 * once `agent-state` is in place. Only intra-library dependencies constrain
 * ordering — a `depends_on.packages` entry that names a package NOT contained
 * in this library (an external dep such as a tool, or another repo's package)
 * is an install-time gate handled elsewhere (`install.ts` dep check), not an
 * ordering edge, so it is ignored here.
 *
 * Algorithm: Kahn's algorithm over the dependency DAG. Independent peers keep
 * their declaration order (stable), which keeps console output and the journal
 * deterministic. A cycle (direct, self, or transitive) leaves nodes unemitted
 * and throws with the offending names so the operator can fix the manifests.
 *
 * @throws Error if a dependency cycle is detected.
 */
export function toposortArtifacts(artifacts: ArtifactEntry[]): ArtifactEntry[] {
  // Index by artifact name so we can tell intra-library deps from external ones.
  const byName = new Map<string, ArtifactEntry>();
  for (const a of artifacts) {
    byName.set(a.manifest.name, a);
  }

  // Build the dependency edges (dependency -> dependent) and in-degrees,
  // counting only deps that resolve to another artifact in THIS library.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of artifacts) {
    inDegree.set(a.manifest.name, inDegree.get(a.manifest.name) ?? 0);
  }
  for (const a of artifacts) {
    const deps = a.manifest.depends_on?.packages ?? [];
    for (const dep of deps) {
      if (!byName.has(dep.name)) continue; // external dep — not an ordering edge
      const list = dependents.get(dep.name) ?? [];
      list.push(a.manifest.name);
      dependents.set(dep.name, list);
      inDegree.set(a.manifest.name, (inDegree.get(a.manifest.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm. Seed the queue in declaration order to keep peers stable.
  const queue: string[] = [];
  for (const a of artifacts) {
    if ((inDegree.get(a.manifest.name) ?? 0) === 0) {
      queue.push(a.manifest.name);
    }
  }

  const ordered: ArtifactEntry[] = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const name = queue[cursor++];
    const node = byName.get(name);
    if (node) ordered.push(node);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== artifacts.length) {
    const emitted = new Set(ordered.map((o) => o.manifest.name));
    const unresolved = artifacts
      .map((a) => a.manifest.name)
      .filter((n) => !emitted.has(n));
    throw new Error(
      `Dependency cycle detected among library artifacts: ${unresolved.join(", ")}`,
    );
  }

  return ordered;
}
