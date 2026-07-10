/**
 * xdg-paths — pure XDG Base Directory resolver, suite-namespaced under
 * `metafactory/<app>/`.
 *
 * CANONICAL HOME: this file lives in arc (the-metafactory/arc). It is
 * designed to be vendored VERBATIM into cortex in a later phase (P3 of
 * epic #1867) — so it deliberately imports nothing beyond Node builtins
 * (`node:path`, `node:os`) and has zero dependency on any other arc module
 * (`paths.ts`, `config.ts`, `types.ts`, …). If you're tempted to import an
 * arc-specific helper here, don't — duplicate the few lines instead, or
 * this module stops being vendorable.
 *
 * Frozen P0 design (#1868):
 * - Suite namespacing: every resolved directory is `<base>/metafactory/<app>/`.
 * - Precedence: explicit `override` > `$XDG_*` env var > spec-default fallback.
 * - POSIX-first; Windows gets the same normalization/comparison rules
 *   `paths.ts` uses for PATH-membership checks (case-insensitive,
 *   separator-agnostic), mirrored here rather than imported.
 *
 * P1 (this file) is the resolver only — nothing in arc adopts it yet.
 * P2 (#287) wires arc's own dirs (repos/cache/config/db) through it.
 */

import { join } from "path";
import { homedir } from "os";

/**
 * Injectable seam for tests — mirrors `paths.ts`'s `{ home, pathEnv,
 * platform, configuredBinDir }` pattern. All fields default to the real
 * process environment when omitted.
 */
export interface XdgSeam {
  /** Injectable `$HOME`. Defaults to `os.homedir()`. */
  home?: string;
  /** Injectable environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable platform, e.g. `"win32"`. Defaults to `process.platform`. */
  platform?: string;
  /**
   * Highest-precedence override. When set (non-empty after trimming), it
   * IS the resolved directory verbatim (after `~` expansion) — no
   * `metafactory/<app>` suffix is appended, no `$XDG_*` var is consulted.
   *
   * This is the seam a caller uses to honor an app-specific override (e.g.
   * arc's own `ARC_CONFIG_ROOT`, which today replaces the entire computed
   * root, not just the XDG base) without this module needing to know that
   * env var's name.
   */
  override?: string;
}

const SUITE = "metafactory";

/** Expand a leading `~` (and only a leading `~`) to `home`. */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.replace(/^~(?=[\/\\])/, home);
}

/** Expand `~` and drop trailing separators (but never collapse `/` itself). */
function normalizePath(path: string, home: string): string {
  const expanded = expandHome(path, home);
  return expanded === "/" ? expanded : expanded.replace(/[\/\\]+$/, "");
}

/**
 * Comparison key for a PATH entry or candidate dir, after home expansion.
 * POSIX paths compare byte-for-byte. Windows paths are case-insensitive and
 * separator-agnostic, so the win32 key is case-folded, `/`-unified to `\`,
 * and stripped of trailing separators. Mirrors `paths.ts`'s
 * `pathComparisonKey` (duplicated, not imported — see file header).
 */
function pathComparisonKey(path: string, home: string, platform: string): string {
  const normalized = normalizePath(path, home);
  if (platform !== "win32") return normalized;
  return normalized.toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "");
}

/**
 * Is `dir` present on a PATH-style string? Delimiter and comparison rules
 * both derive from `platform`, so this is unit-testable for win32 on a
 * POSIX CI host. Mirrors `paths.ts`'s `isDirOnPath`.
 */
export function isDirOnPath(
  dir: string,
  pathEnv: string,
  platform: string,
  home: string,
): boolean {
  const delimiter = platform === "win32" ? ";" : ":";
  const target = pathComparisonKey(dir, home, platform);
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => pathComparisonKey(entry, home, platform) === target);
}

/**
 * Resolve one of the four suite-namespaced XDG directories for `app`:
 * `override` (verbatim) > `$<envVar>/metafactory/<app>` > `<fallback>/metafactory/<app>`.
 */
function suiteDir(
  envVar: string,
  fallbackSegments: string[],
  app: string,
  seam?: XdgSeam,
): string {
  const home = seam?.home ?? homedir();

  const override = seam?.override?.trim();
  if (override) return normalizePath(override, home);

  const env = seam?.env ?? process.env;
  const raw = env[envVar]?.trim();
  const base = raw ? normalizePath(raw, home) : join(home, ...fallbackSegments);

  return join(base, SUITE, app);
}

/**
 * `$XDG_CONFIG_HOME` ?? `~/.config` → `<base>/metafactory/<app>`.
 */
export function configDir(app: string, seam?: XdgSeam): string {
  return suiteDir("XDG_CONFIG_HOME", [".config"], app, seam);
}

/**
 * `$XDG_DATA_HOME` ?? `~/.local/share` → `<base>/metafactory/<app>`.
 */
export function dataDir(app: string, seam?: XdgSeam): string {
  return suiteDir("XDG_DATA_HOME", [".local", "share"], app, seam);
}

/**
 * `$XDG_STATE_HOME` ?? `~/.local/state` → `<base>/metafactory/<app>`.
 */
export function stateDir(app: string, seam?: XdgSeam): string {
  return suiteDir("XDG_STATE_HOME", [".local", "state"], app, seam);
}

/**
 * `$XDG_CACHE_HOME` ?? `~/.local/cache` → `<base>/metafactory/<app>`.
 *
 * Note: this deliberately follows the frozen P0 fallback (`~/.local/cache`),
 * not the upstream XDG spec's `~/.cache` — see #1868.
 */
export function cacheDir(app: string, seam?: XdgSeam): string {
  return suiteDir("XDG_CACHE_HOME", [".local", "cache"], app, seam);
}

/**
 * Resolve the shared bin dir: prefer `~/.local/bin` (or `~/bin`) when
 * already on `$PATH`, else fall back to `~/.local/bin`. Not part of the
 * XDG Base Directory spec (which has no bin dir concept) — this is arc's
 * own convention, generalized here as the one source of truth. Mirrors
 * `paths.ts`'s `resolveDefaultShimDir` (duplicated, not imported — see
 * file header); reconciling that duplication is left to P2 (#287), which
 * is expected to have arc's own dir resolution delegate to this module.
 */
export function binDir(seam?: XdgSeam): string {
  const home = seam?.home ?? homedir();

  const override = seam?.override?.trim();
  if (override) return normalizePath(override, home);

  const env = seam?.env ?? process.env;
  const platform = seam?.platform ?? process.platform;
  const pathEnv = env.PATH ?? "";

  const preferred = [join(home, ".local", "bin"), join(home, "bin")];
  for (const candidate of preferred) {
    if (isDirOnPath(candidate, pathEnv, platform, home)) return candidate;
  }

  return join(home, ".local", "bin");
}
