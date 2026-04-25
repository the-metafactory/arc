import { join, dirname } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type { ArtifactType, ArcManifest, PaiPaths } from "../types.js";
import {
  createSymlink,
  createCliShim,
  extractAllCliInfo,
  removeSymlink,
  removeCliShim,
} from "./symlinks.js";
import { generateRules } from "./rules.js";

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
  paths: PaiPaths;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}): Promise<{
  filesCreated: Array<{ source: string; target: string }>;
  filesMissingSource: Array<{ source: string; target: string }>;
  record: ArtifactSymlinkRecord;
}> {
  const { type, manifest, paths, installDir, quiet } = opts;
  const record: ArtifactSymlinkRecord = { symlinks: [], shims: { dir: paths.shimDir, names: [] } };

  // Helper that wraps createSymlink + tracks the target for rollback (#89).
  const linkTracked = async (source: string, target: string) => {
    await createSymlink(source, target);
    record.symlinks.push(target);
  };
  const shimTracked = async () => {
    const created = await createCliShim(paths.shimDir, paths.binDir, manifest);
    record.shims.names.push(...created);
  };

  // Pre-validation pass (#89): assert every provides.files source exists in
  // the package before we create ANY symlinks. The most common failure mode
  // (manifest typo, repo drift) is now stopped with zero filesystem mutation,
  // so install can return cleanly without producing orphan symlinks.
  const declaredFiles = manifest.provides?.files ?? [];
  const filesMissingSource: Array<{ source: string; target: string }> = [];
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
      const actionLinkPath = join(paths.actionsDir, manifest.name);
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
      // Pipelines: symlink repo root (or pipeline/ subdirectory) to pipelinesDir
      const pipelineSourceDir = join(installDir, "pipeline");
      const sourceDir = existsSync(pipelineSourceDir) ? pipelineSourceDir : installDir;
      const pipelineLinkPath = join(paths.pipelinesDir, manifest.name);
      await linkTracked(sourceDir, pipelineLinkPath);

      // If the manifest declares CLI entries, also create shims
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(paths.binDir, entry.binName);
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
      // Tools: symlink repo root to binDir for each CLI entry
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(paths.binDir, entry.binName);
        await linkTracked(installDir, binLinkPath);
      }
      if (!cliEntries.length) {
        // Fallback: symlink under manifest name if no CLI declared
        await linkTracked(installDir, join(paths.binDir, manifest.name));
      }

      // Create PATH-accessible shims for all CLI entries
      await shimTracked();
      break;
    }

    case "agent": {
      // Agents: symlink the .md file directly into agentsDir for Claude auto-discovery
      const agentSourceDir = join(installDir, "agent");
      const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      const linkPath = join(paths.agentsDir, mdFile);

      if (existsSync(sourcePath)) {
        await linkTracked(sourcePath, linkPath);
      } else {
        // Fallback: symlink directory if .md file not found by convention name
        await linkTracked(sourceDir, join(paths.agentsDir, manifest.name));
      }
      break;
    }

    case "prompt": {
      // Prompts: symlink the .md file directly into promptsDir for Claude auto-discovery
      const promptSourceDir = join(installDir, "prompt");
      const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      const linkPath = join(paths.promptsDir, mdFile);

      if (existsSync(sourcePath)) {
        await linkTracked(sourcePath, linkPath);
      } else {
        // Fallback: symlink directory if .md file not found by convention name
        await linkTracked(sourceDir, join(paths.promptsDir, manifest.name));
      }
      break;
    }

    case "skill":
    case "system":
    default: {
      // Skills: symlink skill/ subdirectory (or root) to skillsDir
      const skillSourceDir = join(installDir, "skill");
      const skillLinkPath = join(paths.skillsDir, manifest.name);

      if (existsSync(skillSourceDir)) {
        await linkTracked(skillSourceDir, skillLinkPath);
      } else {
        await linkTracked(installDir, skillLinkPath);
      }

      // Create bin symlinks and shims for all CLI entries (skills with CLI)
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(paths.binDir, entry.binName);
        await linkTracked(installDir, binLinkPath);
      }
      if (cliEntries.length) {
        await shimTracked();
      }
      break;
    }
  }

  // Type-agnostic provides.files pass.
  // Every artifact type honors provides.files entries — used to ship auxiliary
  // files (hook handlers, helpers, shared libs) alongside the primary layout.
  // Previously only `component` honored this, which silently broke any
  // multi-artifact package using a different primary type. See issue #84.
  // The pre-validation pass above guarantees every source exists by the time
  // we get here, so we can fearlessly create symlinks without partial-state risk.
  const filesCreated: Array<{ source: string; target: string }> = [];
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
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove symlink ${link}: ${err?.message ?? err}`);
      }
    }
  }
  for (const name of record.shims.names) {
    try {
      await removeCliShim(record.shims.dir, name);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove shim ${name}: ${err?.message ?? err}`);
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
