import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import type {
  ArtifactType,
  DarwinLaunchdHostPaths,
  HostAdapter,
} from "../../types.js";

/**
 * darwin-launchd host adapter (arc#140 P2).
 *
 * OS-supervision host for standalone `type: agent` bot packages on macOS,
 * per cortex `docs/design-arc-agent-bots.md` §3.2. Receives:
 *
 *   - `provides.binary`  → `~/bin/<binary>` (symlink to the package install)
 *   - `provides.plist`   → `~/Library/LaunchAgents/<label>.plist` (rendered
 *                           with token substitution, then `launchctl bootstrap`)
 *
 * Tools (`type: tool`) are also supported here as a convenience for
 * platform packages that need their CLI on PATH without requiring a
 * claude-code host (e.g. operator runbook tools on a server without
 * `~/.claude/`). Skills / agents / prompts are not hosted by launchd —
 * those concepts only exist in the claude-code or cortex hosts.
 *
 * Install/remove dispatch (rendering the plist, copying the binary,
 * `launchctl bootstrap` / `bootout`) lands in arc#140 P3. This file is
 * the adapter surface only: `id`, `paths`, `detect()`, `supports()`.
 *
 * Detection rule (intentionally simple):
 *
 *   1. `platform() === "darwin"` — the unit format is macOS-specific.
 *   2. `~/Library/LaunchAgents` exists and is a directory.
 *
 * We do not stat `launchctl` on PATH at `detect()` time — the binary
 * is part of base macOS and a sysadmin-stripped install is exotic enough
 * to defer to install-time error surfacing. (Cortex does the same: it
 * recognizes itself by file presence, not by binary on PATH.)
 *
 * Path semantics:
 *
 *   - `binDir`     → `~/bin` (shared with claude-code's binDir by
 *                    convention — both are ultimately a single PATH-
 *                    accessible shim directory)
 *   - `plistDir`   → `~/Library/LaunchAgents` (extension field)
 *   - `settingsPath` → set to `plistDir` so `host.paths.settingsPath`
 *                      points at the directory whose presence proves the
 *                      adapter is usable; nothing else in arc reads it
 *                      for launchd.
 *   - `skillsDir`, `agentsDir`, `promptsDir` are intentionally empty —
 *     launchd is not those things' host. `supports()` declines those
 *     artifact types directly; the empty paths are belt-and-suspenders.
 */

export interface DarwinLaunchdHostOptions {
  /** Override `~/Library/LaunchAgents` (test isolation). */
  plistDir?: string;
  /** Override `~/bin` (test isolation; shared shim dir with claude-code). */
  binDir?: string;
  /**
   * Override the platform check (test isolation — lets non-darwin CI
   * still exercise the adapter's path-building and `supports()` logic).
   */
  forcePlatform?: NodeJS.Platform;
}

/** Build darwin-launchd host paths rooted at the given directories. */
export function darwinLaunchdPaths(
  opts?: DarwinLaunchdHostOptions,
): DarwinLaunchdHostPaths {
  const home = homedir();
  const plistDir = opts?.plistDir ?? join(home, "Library", "LaunchAgents");
  const binDir = opts?.binDir ?? join(home, "bin");
  return {
    root: plistDir,
    skillsDir: "",
    agentsDir: "",
    promptsDir: "",
    binDir,
    settingsPath: plistDir,
    plistDir,
  };
}

export function createDarwinLaunchdHost(
  opts?: DarwinLaunchdHostOptions,
): HostAdapter & { paths: DarwinLaunchdHostPaths } {
  const paths = darwinLaunchdPaths(opts);
  const onDarwin = (opts?.forcePlatform ?? platform()) === "darwin";
  return {
    id: "darwin-launchd",
    paths,
    detect: () => onDarwin && existsSync(paths.plistDir),
    supports: (type: ArtifactType) => type === "agent" || type === "tool",
  };
}

/**
 * Type guard for the darwin-launchd host's narrowed paths shape.
 *
 * Use this in multi-target dispatch instead of a blanket `as` cast —
 * if `createDarwinLaunchdHost()` is ever refactored to drop the
 * `plistDir` extension, this guard fails fast at runtime with a clear
 * message instead of letting a downstream `.paths.plistDir` access
 * surface as `undefined`. Sage P3 review (arc#143).
 */
export function isDarwinLaunchdHost(
  host: HostAdapter,
): host is HostAdapter & { paths: DarwinLaunchdHostPaths } {
  return (
    host.id === "darwin-launchd" &&
    typeof (host.paths as Partial<DarwinLaunchdHostPaths>).plistDir === "string"
  );
}
