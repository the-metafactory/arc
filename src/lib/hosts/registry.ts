import type { HostAdapter, HostId } from "../../types.js";
import { createClaudeCodeHost } from "./claude-code.js";
import { createCortexHost } from "./cortex.js";
import { createDarwinLaunchdHost } from "./darwin-launchd.js";
import { createLinuxSystemdHost } from "./linux-systemd.js";

/**
 * Per-host adapter constructor overrides (test isolation).
 *
 * In production every adapter resolves its own default paths (`~/.claude`,
 * `~/.config/cortex`, `~/Library/LaunchAgents`); tests override these to
 * sandboxed temp directories. Each key matches the corresponding
 * `createXHost()` option type — adding a new option there means adding
 * it here. Unknown keys are ignored so tests can stay loose.
 */
export interface HostOverrides {
  "claude-code"?: { root?: string };
  cortex?: { configRoot?: string; credsRoot?: string };
  "darwin-launchd"?: {
    plistDir?: string;
    binDir?: string;
    forcePlatform?: NodeJS.Platform;
  };
  "linux-systemd"?: {
    unitDir?: string;
    binDir?: string;
    forcePlatform?: NodeJS.Platform;
  };
}

/**
 * Resolve a host adapter by id, with optional per-host overrides for
 * test isolation. arc#140 P3 uses this when dispatching `manifest.targets`
 * — each declared HostId resolves through this single factory rather than
 * each call site importing every adapter constructor.
 *
 * Throws on unknown / not-yet-implemented host ids so a manifest that
 * declares `targets: [linux-systemd]` today fails with a clear message
 * at install time (the schema gate is permissive on purpose — it
 * validates the ID is *known*, this function validates it's *available*).
 */
export function resolveHost(
  id: HostId,
  overrides?: HostOverrides,
): HostAdapter {
  switch (id) {
    case "claude-code":
      return createClaudeCodeHost(overrides?.["claude-code"]);
    case "cortex":
      return createCortexHost(overrides?.cortex);
    case "darwin-launchd":
      return createDarwinLaunchdHost(overrides?.["darwin-launchd"]);
    case "linux-systemd":
      return createLinuxSystemdHost(overrides?.["linux-systemd"]);
    default: {
      const exhaustive: never = id;
      throw new Error(`Unknown host id: ${exhaustive as string}`);
    }
  }
}

/**
 * Categorise a host for multi-target install ordering.
 *
 * - `registry` hosts (cortex, claude-code) install FIRST — they accept
 *   the identity/persona/skill artifacts the OS-supervision side needs
 *   to be aware of before the daemon launches.
 * - `supervision` hosts (darwin-launchd, linux-systemd) install LAST —
 *   the daemon starts (launchctl bootstrap) only after creds + registry
 *   state are in place.
 *
 * See cortex `docs/design-arc-agent-bots.md` §3.2 ("Ordering invariant
 * across both shapes"): drop fragment → signal reload → issue creds →
 * (standalone only) start daemon.
 */
export type HostCategory = "registry" | "supervision";

export function categorizeHost(id: HostId): HostCategory {
  switch (id) {
    case "claude-code":
    case "cortex":
      return "registry";
    case "darwin-launchd":
    case "linux-systemd":
      return "supervision";
    default: {
      // arc#143 review (sage): exhaustiveness guard matching resolveHost().
      // Adding a new HostId without updating this switch surfaces a
      // compile error; without this case it would silently default to
      // the "supervision" bucket (the else leg of orderTargetsForInstall),
      // violating the install-order invariant with no diagnostic.
      const exhaustive: never = id;
      throw new Error(`Unhandled HostId in categorizeHost: ${exhaustive as string}`);
    }
  }
}

/**
 * Sort `manifest.targets` per the install-ordering invariant: every
 * `registry` host (cortex, claude-code) FIRST, every `supervision`
 * host (darwin-launchd, linux-systemd) AFTER. Stable within each
 * category — declaration order is preserved.
 *
 * On uninstall the caller reverses this array — supervision hosts
 * shut down BEFORE the registry state is cleared.
 */
export function orderTargetsForInstall(targets: HostId[]): HostId[] {
  const registry: HostId[] = [];
  const supervision: HostId[] = [];
  for (const t of targets) {
    if (categorizeHost(t) === "registry") {
      registry.push(t);
    } else {
      supervision.push(t);
    }
  }
  return [...registry, ...supervision];
}
