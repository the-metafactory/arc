import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import type { PaiPaths } from "../types.js";

/**
 * Create PaiPaths with default production paths.
 * Override any field for testing.
 */
export function createPaths(overrides?: Partial<PaiPaths>): PaiPaths {
  const home = homedir();
  const claudeRoot = overrides?.claudeRoot ?? join(home, ".claude");
  const configRoot =
    overrides?.configRoot ??
    (process.env.ARC_CONFIG_ROOT
      ? process.env.ARC_CONFIG_ROOT.replace(/^~/, home)
      : join(home, ".config", "arc"));

  return {
    claudeRoot,
    skillsDir: overrides?.skillsDir ?? join(claudeRoot, "skills"),
    agentsDir: overrides?.agentsDir ?? join(claudeRoot, "agents"),
    promptsDir: overrides?.promptsDir ?? join(claudeRoot, "commands"),
    binDir: overrides?.binDir ?? join(claudeRoot, "bin"),
    reposDir: overrides?.reposDir ?? join(configRoot, "pkg", "repos"),
    dbPath: overrides?.dbPath ?? join(configRoot, "packages.db"),
    configRoot,
    secretsDir: overrides?.secretsDir ?? join(configRoot, "secrets"),
    runtimeDir: overrides?.runtimeDir ?? join(configRoot, "skills"),
    shimDir: overrides?.shimDir ?? join(home, "bin"),
    catalogPath:
      overrides?.catalogPath ??
      join(import.meta.dir, "..", "..", "catalog.yaml"),
    registryPath:
      overrides?.registryPath ??
      join(import.meta.dir, "..", "..", "registry.yaml"),
    sourcesPath:
      overrides?.sourcesPath ??
      join(configRoot, "sources.yaml"),
    cachePath:
      overrides?.cachePath ??
      join(configRoot, "pkg", "cache"),
    pipelinesDir:
      overrides?.pipelinesDir ??
      join(configRoot, "pipelines"),
    settingsPath:
      overrides?.settingsPath ??
      join(claudeRoot, "settings.json"),
  };
}

/**
 * Ensure all required directories exist.
 */
export async function ensureDirectories(paths: PaiPaths): Promise<void> {
  const dirs = [
    paths.skillsDir,
    paths.agentsDir,
    paths.promptsDir,
    paths.binDir,
    paths.reposDir,
    paths.configRoot,
    paths.secretsDir,
    paths.runtimeDir,
    paths.pipelinesDir,
  ];

  for (const dir of dirs) {
    await Bun.write(join(dir, ".gitkeep"), "");
    // Bun.write auto-creates parent directories
  }
}

/**
 * Walk up from a directory to find the git root (directory containing .git).
 * Returns the git root path or null if not found within 10 levels.
 */
export function findGitRoot(startPath: string): string | null {
  let current = startPath;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
