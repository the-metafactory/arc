import { join } from "path";
import { homedir } from "os";
import type { PaiPaths } from "../types.js";

/**
 * Create PaiPaths with default production paths.
 * Override any field for testing.
 */
export function createPaths(overrides?: Partial<PaiPaths>): PaiPaths {
  const home = homedir();
  const claudeRoot = overrides?.claudeRoot ?? join(home, ".claude");
  const configRoot = overrides?.configRoot ?? join(home, ".config", "pai");

  return {
    claudeRoot,
    skillsDir: overrides?.skillsDir ?? join(claudeRoot, "skills"),
    binDir: overrides?.binDir ?? join(claudeRoot, "bin"),
    reposDir: overrides?.reposDir ?? join(configRoot, "pkg", "repos"),
    dbPath: overrides?.dbPath ?? join(configRoot, "packages.db"),
    configRoot,
    secretsDir: overrides?.secretsDir ?? join(configRoot, "secrets"),
    runtimeDir: overrides?.runtimeDir ?? join(configRoot, "skills"),
  };
}

/**
 * Ensure all required directories exist.
 */
export async function ensureDirectories(paths: PaiPaths): Promise<void> {
  const dirs = [
    paths.skillsDir,
    paths.binDir,
    paths.reposDir,
    paths.configRoot,
    paths.secretsDir,
    paths.runtimeDir,
  ];

  for (const dir of dirs) {
    await Bun.write(join(dir, ".gitkeep"), "");
    // Bun.write auto-creates parent directories
  }
}
