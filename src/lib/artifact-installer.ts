import { join, dirname } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type { ArtifactType, ArcManifest, PaiPaths } from "../types.js";
import { createSymlink, createCliShim, extractAllCliInfo } from "./symlinks.js";
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
export async function createArtifactSymlinks(opts: {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  paths: PaiPaths;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}): Promise<void> {
  const { type, manifest, paths, installDir, quiet } = opts;

  switch (type) {
    case "action": {
      // Actions: symlink action directory into actionsDir
      const actionLinkPath = join(paths.actionsDir, manifest.name);
      await createSymlink(installDir, actionLinkPath);
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
      await createSymlink(sourceDir, pipelineLinkPath);

      // If the manifest declares CLI entries, also create shims
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(paths.binDir, entry.binName);
        await createSymlink(installDir, binLinkPath);
      }
      if (cliEntries.length) {
        await createCliShim(paths.shimDir, paths.binDir, manifest);
      }
      break;
    }

    case "component": {
      // Components: symlink each provides.files entry from repo source to expanded target
      const files = manifest.provides?.files ?? [];
      for (const file of files) {
        const sourcePath = join(installDir, file.source);
        const targetPath = file.target.replace(/^~/, homedir());
        await mkdir(dirname(targetPath), { recursive: true });
        await createSymlink(sourcePath, targetPath);
      }
      break;
    }

    case "tool": {
      // Tools: symlink repo root to binDir for each CLI entry
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(paths.binDir, entry.binName);
        await createSymlink(installDir, binLinkPath);
      }
      if (!cliEntries.length) {
        // Fallback: symlink under manifest name if no CLI declared
        await createSymlink(installDir, join(paths.binDir, manifest.name));
      }

      // Create PATH-accessible shims for all CLI entries
      await createCliShim(paths.shimDir, paths.binDir, manifest);
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
        await createSymlink(sourcePath, linkPath);
      } else {
        // Fallback: symlink directory if .md file not found by convention name
        await createSymlink(sourceDir, join(paths.agentsDir, manifest.name));
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
        await createSymlink(sourcePath, linkPath);
      } else {
        // Fallback: symlink directory if .md file not found by convention name
        await createSymlink(sourceDir, join(paths.promptsDir, manifest.name));
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
        await createSymlink(skillSourceDir, skillLinkPath);
      } else {
        await createSymlink(installDir, skillLinkPath);
      }

      // Create bin symlinks and shims for all CLI entries (skills with CLI)
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        const binLinkPath = join(paths.binDir, entry.binName);
        await createSymlink(installDir, binLinkPath);
      }
      if (cliEntries.length) {
        await createCliShim(paths.shimDir, paths.binDir, manifest);
      }
      break;
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
