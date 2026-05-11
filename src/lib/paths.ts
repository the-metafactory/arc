import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, renameSync } from "fs";
import type { ArcPaths, HostAdapter, PaiPaths } from "../types.js";
import { createClaudeCodeHost } from "./hosts/claude-code.js";

// TODO: Remove migration logic after 2026-Q3. Only 2 users (founders) on arc currently,
// so this migration path can be dropped once both have upgraded.
/**
 * Migrate config data from the old ~/.config/arc/ path to ~/.config/metafactory/.
 * One-time, idempotent operation. Only runs when:
 * - Using default paths (no ARC_CONFIG_ROOT env var, no configRoot override)
 * - Old path exists AND new path does NOT exist
 */
export function migrateConfigIfNeeded(oldPath: string, newPath: string): void {
  try {
    if (existsSync(oldPath) && !existsSync(newPath)) {
      renameSync(oldPath, newPath);
      console.log(`Migrated config from ${oldPath} to ${newPath}`);
    }
  } catch (err) {
    console.warn(
      `Warning: failed to migrate config from ${oldPath} to ${newPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Resolve the config root from override → env var → default. Triggers the
 * one-time ~/.config/arc/ → ~/.config/metafactory/ migration when no override
 * or env var is in play.
 */
function resolveConfigRoot(override?: string): string {
  const home = homedir();
  const usingEnvVar = !!process.env.ARC_CONFIG_ROOT;
  const usingOverride = !!override;
  const defaultConfigRoot = join(home, ".config", "metafactory");

  const configRoot =
    override ??
    (usingEnvVar
      ? process.env.ARC_CONFIG_ROOT!.replace(/^~/, home)
      : defaultConfigRoot);

  if (!usingEnvVar && !usingOverride) {
    const oldConfigRoot = join(home, ".config", "arc");
    migrateConfigIfNeeded(oldConfigRoot, configRoot);
  }

  return configRoot;
}

/**
 * Create ArcPaths — arc's host-independent state directories. Override any
 * field for testing.
 */
export function createArcPaths(overrides?: Partial<ArcPaths>): ArcPaths {
  const home = homedir();
  const configRoot = resolveConfigRoot(overrides?.configRoot);

  return {
    configRoot,
    reposDir: overrides?.reposDir ?? join(configRoot, "pkg", "repos"),
    cachePath: overrides?.cachePath ?? join(configRoot, "pkg", "cache"),
    dbPath: overrides?.dbPath ?? join(configRoot, "packages.db"),
    sourcesPath: overrides?.sourcesPath ?? join(configRoot, "sources.yaml"),
    secretsDir: overrides?.secretsDir ?? join(configRoot, "secrets"),
    runtimeDir: overrides?.runtimeDir ?? join(configRoot, "skills"),
    pipelinesDir: overrides?.pipelinesDir ?? join(configRoot, "pipelines"),
    actionsDir: overrides?.actionsDir ?? join(configRoot, "actions"),
    shimDir: overrides?.shimDir ?? join(home, "bin"),
    catalogPath:
      overrides?.catalogPath ?? join(import.meta.dir, "..", "..", "catalog.yaml"),
    registryPath:
      overrides?.registryPath ?? join(import.meta.dir, "..", "..", "registry.yaml"),
  };
}

/**
 * Return the default host adapter. Phase 1: always Claude Code. Phase 2 of
 * #117 adds detection-based selection across multiple backends.
 */
export function getDefaultHost(opts?: { root?: string }): HostAdapter {
  return createClaudeCodeHost(opts);
}

/**
 * Create PaiPaths with default production paths. Override any field for testing.
 *
 * @deprecated Use createArcPaths() + getDefaultHost() instead. Kept for
 *   backward compatibility during the multi-backend migration (#117). Will be
 *   removed in Phase 3.
 */
export function createPaths(overrides?: Partial<PaiPaths>): PaiPaths {
  const home = homedir();
  const claudeRoot = overrides?.claudeRoot ?? join(home, ".claude");

  const arc = createArcPaths(overrides);
  const host = createClaudeCodeHost({ root: claudeRoot });

  return {
    ...arc,
    claudeRoot,
    skillsDir: overrides?.skillsDir ?? host.paths.skillsDir,
    agentsDir: overrides?.agentsDir ?? host.paths.agentsDir,
    promptsDir: overrides?.promptsDir ?? host.paths.promptsDir,
    binDir: overrides?.binDir ?? host.paths.binDir,
    settingsPath: overrides?.settingsPath ?? host.paths.settingsPath,
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
    paths.actionsDir,
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
