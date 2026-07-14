/**
 * cortex-config-dir — existence-gated resolver for cortex's config DIRECTORY,
 * mirroring cortex's own `resolveConfigDir` (G-18, EPIC cortex#1867).
 *
 * WHY THIS EXISTS — the trust hazard it closes:
 *
 * arc provisions agent identity fragments (`agents.d/<id>.yaml`) and personas
 * INTO cortex's config tree. The live cortex reads that tree via
 * `resolveConfigDir` (cortex `src/common/config/config-path.ts`), which — after
 * the XDG wave-4 config-dir move (cortex#1869) — is existence-gated: canonical
 * `~/.config/metafactory/cortex` if present, else the legacy trees. If arc
 * instead hardcodes the pre-move `~/.config/cortex`, then on a MIGRATED box arc
 * writes to a tree the running cortex no longer reads → the agents silently
 * vanish from the roster (misprovisioning the live box). So arc MUST resolve
 * cortex's config dir the SAME way cortex does, and always write where cortex
 * reads.
 *
 * This module is the single source of that resolution. It byte-mirrors cortex's
 * `resolveConfigDir` PRECEDENCE exactly (see the drift-oracle test):
 *
 *   1. `$CORTEX_CONFIG_DIR` (trimmed; blank/whitespace ⇒ unset) — VERBATIM, a
 *      self-contained config root. No `~`-expansion, no legacy probe.
 *   2. canonical `~/.config/metafactory/cortex` — if it exists.
 *   3. legacy flat `~/.config/cortex` — if it exists.
 *   4. legacy `~/.config/grove` — if it exists.
 *   5. canonical `~/.config/metafactory/cortex` — the write/default target on a
 *      fresh host (never a legacy tree).
 *
 * DELIBERATELY NOT `xdg-paths.configDir`: cortex hardcodes `.config` here and
 * does NOT consult `$XDG_CONFIG_HOME` for its config dir (its config move folded
 * under `metafactory/` but kept the `~/.config` base). arc's `configDir` DOES
 * honor `$XDG_CONFIG_HOME`, so reusing it would make arc and cortex disagree on
 * the live tree whenever `$XDG_CONFIG_HOME` is set. Byte-matching cortex means
 * hardcoding `.config`, so this is a separate, cortex-specific resolver.
 *
 * SCOPE — this only RESOLVES cortex's config dir; it never moves or migrates it.
 * cortex owns that tree and the physical move (cortex#1869). arc reads it.
 *
 * The `{home, env}` seam is injectable for hermetic tests (never touch the real
 * `~/.config`). It mirrors cortex's `home` override + its `process.env`-read of
 * `CORTEX_CONFIG_DIR` (via `readDirEnv`).
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

/** The shared metafactory XDG root under `~/.config` (cortex wave-4 cutover). */
export const METAFACTORY_DIRNAME = "metafactory";
/** The canonical cortex config directory name (nested under `metafactory/`). */
export const CORTEX_CONFIG_DIRNAME = "cortex";
/** The legacy grove config directory name (read-fallback only). */
export const GROVE_CONFIG_DIRNAME = "grove";

/**
 * Injectable `{home, env}` seam for hermetic tests. Both default to the real
 * process environment when omitted — mirroring cortex's `home` param and its
 * `process.env` read of `CORTEX_CONFIG_DIR`.
 */
export interface CortexConfigDirSeam {
  /** Injectable `$HOME`. Defaults to `os.homedir()`. */
  home?: string;
  /** Injectable environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function seamHome(seam?: CortexConfigDirSeam): string {
  return seam?.home ?? homedir();
}

function seamEnv(seam?: CortexConfigDirSeam): Record<string, string | undefined> {
  return seam?.env ?? process.env;
}

/**
 * The `CORTEX_CONFIG_DIR` override, or `undefined` when unset/blank.
 *
 * Mirrors cortex's `readDirEnv`: the value is TRIMMED, and a value that is
 * empty *after trimming* reads as unset (so `CORTEX_CONFIG_DIR=` and
 * `CORTEX_CONFIG_DIR="  "` keep the default behavior, never a literal `"  "`
 * relative dir). When set it is the config directory VERBATIM.
 */
export function cortexConfigDirOverride(seam?: CortexConfigDirSeam): string | undefined {
  const raw = seamEnv(seam).CORTEX_CONFIG_DIR;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The canonical cortex config dir: `$CORTEX_CONFIG_DIR` (verbatim) if set, else
 * `~/.config/metafactory/cortex`. Mirrors cortex's `cortexConfigDir`.
 */
export function cortexCanonicalConfigDir(seam?: CortexConfigDirSeam): string {
  return (
    cortexConfigDirOverride(seam) ??
    join(seamHome(seam), ".config", METAFACTORY_DIRNAME, CORTEX_CONFIG_DIRNAME)
  );
}

/** Legacy flat cortex config dir `~/.config/cortex` (read-fallback only). */
export function legacyCortexConfigDir(seam?: CortexConfigDirSeam): string {
  return join(seamHome(seam), ".config", CORTEX_CONFIG_DIRNAME);
}

/** Legacy grove config dir `~/.config/grove` (oldest read-fallback). */
export function groveConfigDir(seam?: CortexConfigDirSeam): string {
  return join(seamHome(seam), ".config", GROVE_CONFIG_DIRNAME);
}

/**
 * Resolve cortex's config DIRECTORY, existence-gated, byte-matching cortex's
 * `resolveConfigDir` precedence (see file header). An explicit
 * `$CORTEX_CONFIG_DIR` short-circuits all fallback (it is a self-contained
 * root); otherwise the canonical tree wins if it exists, then the legacy flat
 * cortex tree, then grove, then the canonical path as the fresh-host default.
 *
 * arc routes every DEFAULT cortex-config resolution through this so a bot-pack
 * always lands where the running cortex reads — legacy on a pre-cutover box,
 * canonical on a migrated one.
 */
export function resolveCortexConfigDir(seam?: CortexConfigDirSeam): string {
  const canonical = cortexCanonicalConfigDir(seam);
  // An explicit override is a self-contained root — never probe legacy trees.
  if (cortexConfigDirOverride(seam) !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;

  const legacyCortex = legacyCortexConfigDir(seam);
  if (existsSync(legacyCortex)) return legacyCortex;

  const grove = groveConfigDir(seam);
  if (existsSync(grove)) return grove;

  return canonical;
}
