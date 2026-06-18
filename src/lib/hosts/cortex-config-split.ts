import { join, dirname } from "path";
import { existsSync, statSync } from "fs";
import { homedir } from "os";

/**
 * Config-split stack targeting for the cortex host (arc#244 S1 / cortex#1133).
 *
 * cortex's standard config layout is **config-split**: a stack's config is a
 * directory the daemon points `--config` at, containing `system/system.yaml`,
 * `stacks/*.yaml`, `agents.d/`, `personas/`, etc. The single-file
 * `~/.config/cortex/cortex.yaml` form is **legacy**.
 *
 * arc's cortex host (`cortex.ts`) defaults `configRoot` to `~/.config/cortex`
 * and resolves `agents.d/` + `personas/` off that root — i.e. the LEGACY
 * location. So a bot-pack installed today lands its identity fragment + persona
 * in the cortex *root*, not inside the stack dir a real config-split deployment
 * actually loads. This module resolves a stack-aware `configRoot` so
 * `agents.d/<id>.yaml` + `personas/<id>.md` land in the stack subdir.
 *
 * We DO NOT reinvent the layout detection — we mirror cortex itself
 * (`src/common/config/loader.ts`):
 *   - `LAYOUT_MARKER = join("system", "system.yaml")` selects the split layout.
 *   - `--config` points at a POINTER (sentinel) file whose **dirname** is the
 *     config dir; the pointer's *contents are ignored* and its *basename* names
 *     the single-instance PID file. So when `--config-dir` is handed a file, we
 *     take its dirname — exactly cortex's pointer-basename/dirname convention.
 */

/**
 * The marker file (relative to a config dir) whose presence selects cortex's
 * directory (config-split) layout. Mirrors cortex `loader.ts` `LAYOUT_MARKER`
 * — keep these in lockstep.
 */
export const CORTEX_LAYOUT_MARKER = join("system", "system.yaml");

export type CortexLayout = "config-split" | "legacy";

/**
 * Classify a cortex config dir by cortex's own rule: the directory layout is in
 * effect iff `<dir>/system/system.yaml` exists; otherwise it's the single-file
 * (legacy) fallback. A non-existent dir reads as `legacy` — there's nothing to
 * detect, and the legacy single-file fallback is what cortex would use.
 */
export function detectCortexLayout(configDir: string): CortexLayout {
  return existsSync(join(configDir, CORTEX_LAYOUT_MARKER))
    ? "config-split"
    : "legacy";
}

/** Where the resolved configRoot came from — for messaging + tests. */
export type CortexConfigRootSource = "default" | "stack" | "config-dir";

export interface ResolveCortexConfigRootOpts {
  /**
   * Explicit stack config dir (`--config-dir`). Either the stack DIRECTORY
   * (`~/.config/cortex/meta-factory`) or the POINTER file inside it
   * (`~/.config/cortex/meta-factory/meta-factory.yaml`) — a pointer is resolved
   * to its dirname per cortex's convention. A leading `~` is expanded.
   */
  configDir?: string;
  /**
   * Stack name (`--stack`). Resolved to `~/.config/cortex/<name>`. Mutually
   * exclusive with `configDir`.
   */
  stack?: string;
  /** Home dir override (test isolation). Defaults to os.homedir(). */
  home?: string;
}

export interface ResolvedCortexConfigRoot {
  /**
   * The cortex `configRoot` to use, or `undefined` when no flag was passed —
   * in which case the caller keeps the byte-identical legacy default
   * (`~/.config/cortex`). Threaded into `createCortexHost({ configRoot })` so
   * `agentsDir` / `personasDir` / `settingsPath` resolve to the stack subdir.
   */
  configRoot: string | undefined;
  source: CortexConfigRootSource;
}

/**
 * Build the install steering a config-split target needs, from the CLI flags.
 *
 * - `hostOverrides` carries `cortex.configRoot` (the resolved stack dir) so the
 *   cortex host (and `installPerTarget` → `resolveHost("cortex", …)`) roots
 *   `agents.d/` + `personas/` at the STACK SUBDIR. When no flag was passed this
 *   is `undefined`, so install() keeps the default `~/.config/cortex` host — the
 *   byte-identical legacy path. (credsRoot is intentionally NOT overridden:
 *   creds stay at the NATS-conventional `~/.config/nats/creds`.)
 * - `cortexConfigEnv` carries `CORTEX_CONFIG` (the stack pointer/config dir) so
 *   a pack's postinstall reload + creds scripts target the right stack rather
 *   than the legacy root. Empty when no flag was passed.
 *
 * Pure (modulo the existsSync/statSync in resolveCortexConfigRoot) — the CLI
 * stays a thin wiring layer over this.
 */
export interface CortexInstallSteering {
  hostOverrides: { cortex: { configRoot: string } } | undefined;
  cortexConfigEnv: Record<string, string>;
  resolved: ResolvedCortexConfigRoot;
}

export function buildCortexInstallSteering(
  opts: ResolveCortexConfigRootOpts,
): CortexInstallSteering {
  const resolved = resolveCortexConfigRoot(opts);
  if (resolved.configRoot == null) {
    return { hostOverrides: undefined, cortexConfigEnv: {}, resolved };
  }
  return {
    hostOverrides: { cortex: { configRoot: resolved.configRoot } },
    // Reload/creds postinstall scripts read CORTEX_CONFIG to target the stack.
    cortexConfigEnv: { CORTEX_CONFIG: resolved.configRoot },
    resolved,
  };
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Resolve the cortex `configRoot` from `--config-dir` / `--stack`.
 *
 * Resolution table:
 *   - neither flag        → `{ configRoot: undefined, source: "default" }`
 *                           (caller keeps legacy `~/.config/cortex`)
 *   - `--stack <name>`    → `~/.config/cortex/<name>`
 *   - `--config-dir <p>`  → `<p>` if `p` is a directory; `dirname(p)` if `p`
 *                           is a file (cortex pointer-file convention)
 *
 * Trust-adjacent: this decides WHERE per-agent identity + (downstream) creds
 * get provisioned, so the inputs are validated strictly — a bad stack name
 * must never let agent state escape the cortex config tree.
 */
export function resolveCortexConfigRoot(
  opts: ResolveCortexConfigRootOpts,
): ResolvedCortexConfigRoot {
  const home = opts.home ?? homedir();

  if (opts.configDir != null && opts.stack != null) {
    throw new Error(
      "Cannot pass both --config-dir and --stack; choose one (a stack dir, or a stack name under ~/.config/cortex).",
    );
  }

  if (opts.stack != null) {
    const name = opts.stack.trim();
    // Traversal guard: a stack name is a single path segment under
    // ~/.config/cortex. Reject separators / parent refs so `--stack ../evil`
    // can't scatter agent identity outside the cortex config tree.
    if (
      name === "" ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      throw new Error(
        `Invalid --stack name "${opts.stack}": must be a single directory name (no path separators).`,
      );
    }
    return {
      configRoot: join(home, ".config", "cortex", name),
      source: "stack",
    };
  }

  if (opts.configDir != null) {
    const expanded = expandHome(opts.configDir, home);
    // Pointer-file convention: if the path is an existing FILE, the config dir
    // is its dirname (cortex `--config` points at the sentinel/pointer file).
    // If it's a directory (or doesn't exist yet), treat it as the config dir.
    let configRoot = expanded;
    if (existsSync(expanded) && statSync(expanded).isFile()) {
      configRoot = dirname(expanded);
    }
    return { configRoot, source: "config-dir" };
  }

  return { configRoot: undefined, source: "default" };
}
