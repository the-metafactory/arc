import { join } from "path";
import { existsSync, renameSync } from "fs";
import { homedir } from "os";
import type { PaiPaths } from "../types.js";

/**
 * Migrate ~/.config/pai/ to ~/.config/arc/ if needed.
 * - If old path exists and new path does not: rename (move) the directory.
 * - If both exist: skip (user may have both intentionally).
 * - Logs to stderr what happened.
 */
function migrateConfigPaths(home: string): void {
  const oldPath = join(home, ".config", "pai");
  const newPath = join(home, ".config", "arc");

  if (existsSync(oldPath) && !existsSync(newPath)) {
    try {
      renameSync(oldPath, newPath);
      process.stderr.write(`arc: migrated config ${oldPath} → ${newPath}\n`);
    } catch (err: any) {
      process.stderr.write(`arc: config migration failed (${oldPath} → ${newPath}): ${err.message}\n`);
    }
  }
}

/**
 * Create PaiPaths with default production paths.
 * Override any field for testing.
 */
export function createPaths(overrides?: Partial<PaiPaths>): PaiPaths {
  const home = homedir();
  const claudeRoot = overrides?.claudeRoot ?? join(home, ".claude");
  const configRoot = overrides?.configRoot ?? join(home, ".config", "arc");

  // Migrate old config path if needed (before returning paths)
  if (!overrides?.configRoot) {
    migrateConfigPaths(home);
  }

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
  ];

  for (const dir of dirs) {
    await Bun.write(join(dir, ".gitkeep"), "");
    // Bun.write auto-creates parent directories
  }
}
