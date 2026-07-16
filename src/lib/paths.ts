import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, renameSync } from "fs";
import { mkdir } from "fs/promises";
import type { ArcPaths, HostAdapter } from "../types.js";
import { createClaudeCodeHost } from "./hosts/claude-code.js";
import { loadUserConfigSync, normalizeUserPath } from "./config.js";
import {
  configDir as xdgConfigDir,
  dataDir as xdgDataDir,
  stateDir as xdgStateDir,
  cacheDir as xdgCacheDir,
} from "./xdg-paths.js";

/** arc's XDG suite-app namespace. Every XDG root resolves under `metafactory/arc`. */
export const ARC_APP = "arc";

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
 * Injectable host seam for path resolution. Both fields default to the real
 * process values (`homedir()` / `process.env`) when omitted, so existing
 * callers are unaffected. Tests inject a scratch `$HOME` and a synthetic env
 * bag to resolve paths with zero real-home access.
 */
export interface PathSeam {
  /** Home directory. Defaults to `homedir()`. */
  home?: string;
  /** Environment bag. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * True when arc resolves its own dirs from the DEFAULT (XDG) layout — i.e. no
 * programmatic `overrides.configRoot` and no `ARC_CONFIG_ROOT` env var. This is
 * the ONLY branch on which the #287 migration-on-touch may fire; when an
 * override or env var is in play arc keeps the legacy single-tree layout
 * (byte-identical to pre-#287) and migration is suppressed.
 */
export function isArcDefaultLayout(
  overrideConfigRoot?: string,
  seam?: PathSeam,
): boolean {
  const env = seam?.env ?? process.env;
  return overrideConfigRoot == null && !env.ARC_CONFIG_ROOT;
}

/**
 * Config-root override precedence — arc's OWN config tree (`sources.yaml`,
 * `secrets/`, `skills/`, …). Ranked most-authoritative first:
 *
 *   1. `overrides.configRoot` — programmatic override passed to `createArcPaths`
 *      (how `test/helpers/test-env.ts` isolates a suite). Beats everything below.
 *   2. `ARC_CONFIG_ROOT` — env override for the whole arc config tree. A leading
 *      `~` is expanded. This is the ONE knob that relocates arc's own state; it
 *      keeps arc in the legacy SINGLE-TREE layout (data/state/cache collapse
 *      onto it, preserving the pre-#287 `pkg/…` tails).
 *   3. Default `$XDG_CONFIG_HOME/metafactory/arc` (fallback `~/.config/metafactory/arc`).
 *      #287 (P2): arc adopts the shared xdg-paths resolver for its own config
 *      root — `$XDG_CONFIG_HOME` is now honored (previously hard-coded to
 *      `~/.config/metafactory` and only `ARC_CONFIG_ROOT` was read).
 *
 * Three OTHER env vars look related but are INDEPENDENT — none composes with
 * `ARC_CONFIG_ROOT`; each governs only its own narrow subtree and bypasses this
 * resolver entirely:
 *
 *   - `METAFACTORY_CONFIG_DIR` (`src/commands/identity.ts`) — the identity
 *     command's keystore base (`keys/`, `principals.json`) ONLY. Because it
 *     bypasses this resolver, setting `ARC_CONFIG_ROOT` alone does NOT move the
 *     identity keystore. No `~` expansion.
 *   - `MF_SIDECAR_DIR` (`src/lib/identity-provision.ts`) — the agent
 *     provisioning-sidecar base (`<...>/agents/<id>.provision.json`) ONLY,
 *     default `~/.config/metafactory/agents`. Independent of both roots above.
 *
 * On the default (XDG) branch the legacy `~/.config/arc/` → `~/.config/metafactory/`
 * rename still runs (existence-gated, a no-op for everyone but the two founders);
 * the subsequent `~/.config/metafactory` → `~/.config/metafactory/arc` hop is the
 * copy-keep-source config-children migration in `migrateArcDirsIfNeeded` (#287).
 */
export function resolveConfigRoot(override?: string, seam?: PathSeam): string {
  const home = seam?.home ?? homedir();
  const env = seam?.env ?? process.env;

  if (override != null) return override;

  const envConfigRoot = env.ARC_CONFIG_ROOT;
  if (envConfigRoot) return envConfigRoot.replace(/^~/, home);

  // Default (XDG) branch. Preserve the legacy gen0→gen1 rename first so a
  // founder still on `~/.config/arc/` lands at `~/.config/metafactory/`, from
  // where the #287 config-children migration relocates into `…/metafactory/arc`.
  const gen0 = join(home, ".config", "arc");
  const gen1 = join(home, ".config", "metafactory");
  migrateConfigIfNeeded(gen0, gen1);

  return xdgConfigDir(ARC_APP, { home, env });
}

/**
 * Comparison key for a PATH entry or candidate dir, after home expansion.
 * POSIX paths compare byte-for-byte. Windows paths are case-insensitive and
 * separator-agnostic, so the win32 key is case-folded, `/`-unified to `\`,
 * and stripped of trailing separators — `C:\Users\K\.local\bin`,
 * `c:\users\k\.local\bin\`, and `C:/Users/k/.local/bin` all collapse to the
 * same key.
 */
function pathComparisonKey(path: string, home: string, platform: string): string {
  const normalized = normalizeUserPath(path, home);
  if (platform !== "win32") return normalized;
  return normalized.toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "");
}

/**
 * Is `dir` present on a PATH-style string? The split delimiter (`;` vs `:`)
 * and the comparison rules (Windows is case-insensitive and
 * separator-agnostic; POSIX is byte-sensitive) are both facts of the
 * platform, so the injectable is the platform itself — defaults to the host,
 * overridable so the win32 behavior is unit-testable on a POSIX CI host
 * (the same pattern as createCliShim in symlinks.ts). The previous
 * hard-coded `:` split mangled Windows `PATH` entries: each entry's `C:\...`
 * drive letter contains a `:`, so the split shredded every path.
 */
export function isDirOnPath(
  dir: string,
  pathEnv: string = process.env.PATH ?? "",
  platform: string = process.platform,
  home: string = homedir(),
): boolean {
  const delimiter = platform === "win32" ? ";" : ":";
  const target = pathComparisonKey(dir, home, platform);
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => pathComparisonKey(entry, home, platform) === target);
}

export function resolveDefaultShimDir(opts?: {
  home?: string;
  pathEnv?: string;
  configuredBinDir?: string;
  platform?: string;
}): string {
  const home = opts?.home ?? homedir();
  const configured = opts?.configuredBinDir?.trim();
  if (configured) return normalizeUserPath(configured, home);

  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? "";
  const platform = opts?.platform ?? process.platform;

  const preferred = [
    join(home, ".local", "bin"),
    join(home, "bin"),
  ];

  for (const candidate of preferred) {
    if (isDirOnPath(candidate, pathEnv, platform, home)) return candidate;
  }

  return join(home, ".local", "bin");
}

/**
 * Create ArcPaths — arc's host-independent state directories. Override any
 * field for testing. The optional `seam` injects `{home, env}` (defaults:
 * `homedir()` / `process.env`) so a test can resolve every path against a
 * scratch `$HOME` with zero real-home access; existing callers pass nothing and
 * behavior is unchanged.
 */
export function createArcPaths(
  overrides?: Partial<ArcPaths>,
  seam?: PathSeam,
): ArcPaths {
  const home = seam?.home ?? homedir();
  const env = seam?.env ?? process.env;
  const configRoot = resolveConfigRoot(overrides?.configRoot, { home, env });
  const userConfig = loadUserConfigSync(configRoot, home);
  const configuredShimDir =
    env.ARC_BIN_DIR ??
    env.ARC_SHIM_DIR ??
    userConfig.binDir;

  // #287 (P2): on the default layout arc splits its class roots across the XDG
  // base dirs (data/state/cache each honoring `$XDG_*`). When an override or
  // `ARC_CONFIG_ROOT` is in play we keep the legacy SINGLE-TREE layout — every
  // class root collapses onto configRoot and the pre-#287 `pkg/…` path tails are
  // preserved byte-for-byte, so relocated / test-isolated installs are unchanged
  // and no migration fires.
  const singleTree = !isArcDefaultLayout(overrides?.configRoot, { home, env });
  const dataRoot =
    overrides?.dataRoot ?? (singleTree ? configRoot : xdgDataDir(ARC_APP, { home, env }));
  const stateRoot =
    overrides?.stateRoot ?? (singleTree ? configRoot : xdgStateDir(ARC_APP, { home, env }));
  const cacheRoot =
    overrides?.cacheRoot ?? (singleTree ? configRoot : xdgCacheDir(ARC_APP, { home, env }));

  return {
    configRoot,
    dataRoot,
    stateRoot,
    cacheRoot,
    // Data class — durable, authoritative installed-package state. packages.db
    // is the source of truth mapping installed packages → on-disk repos; losing
    // it orphans every symlink, so it is DATA (not regenerable cache, not
    // transient state). repos are the cloned package trees the symlinks target.
    reposDir:
      overrides?.reposDir ?? (singleTree ? join(configRoot, "pkg", "repos") : join(dataRoot, "repos")),
    // Cache class — regenerable remote-registry index. Safe to nuke; rebuilt on
    // `arc source update`.
    cachePath:
      overrides?.cachePath ?? (singleTree ? join(configRoot, "pkg", "cache") : join(cacheRoot, "cache")),
    dbPath:
      overrides?.dbPath ?? (singleTree ? join(configRoot, "packages.db") : join(dataRoot, "packages.db")),
    sourcesPath: overrides?.sourcesPath ?? join(configRoot, "sources.yaml"),
    secretsDir: overrides?.secretsDir ?? join(configRoot, "secrets"),
    runtimeDir: overrides?.runtimeDir ?? join(configRoot, "skills"),
    pipelinesDir: overrides?.pipelinesDir ?? join(configRoot, "pipelines"),
    actionsDir: overrides?.actionsDir ?? join(configRoot, "actions"),
    shimDir: overrides?.shimDir ?? resolveDefaultShimDir({
      home,
      pathEnv: env.PATH,
      configuredBinDir: configuredShimDir,
    }),
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
 * Ensure all required directories exist — arc state + host-managed dirs.
 *
 * Intentionally NOT in this list:
 * - `arc.cachePath` — file path, not a directory; remote-registry lazy-creates the parent.
 * - `arc.dbPath` / `arc.sourcesPath` / `arc.registryPath` — file
 *   paths created on first write (`openDatabase`, `saveSources`, etc.).
 * - `arc.shimDir` — created on first `arc install` of a CLI artifact (createCliShim).
 * - `host.paths.settingsPath` — host-owned file; we never pre-create it.
 *
 * When adding a new directory-shaped field to `ArcPaths` or `HostPaths`, also
 * add it here. Files belong elsewhere.
 */
export async function ensureDirectories(
  arc: ArcPaths,
  host: HostAdapter,
): Promise<void> {
  const dirs = [
    arc.reposDir,
    arc.configRoot,
    arc.secretsDir,
    arc.runtimeDir,
    arc.pipelinesDir,
    arc.actionsDir,
    host.paths.skillsDir,
    host.paths.agentsDir,
    host.paths.promptsDir,
    host.paths.binDir,
  ];

  for (const dir of dirs) {
    // Explicit mkdir — Bun.write only auto-creates parents on Bun ≥1.2.
    // Don't gate arc's first-install on a particular Bun runtime.
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, ".gitkeep"), "");
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
