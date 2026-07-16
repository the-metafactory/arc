import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { binDir as resolveSharedBinDir } from "../xdg-paths.js";
import type {
  ArtifactType,
  HostAdapter,
  LinuxSystemdHostPaths,
} from "../../types.js";

/**
 * linux-systemd host adapter (arc#140 P6).
 *
 * Sister to the darwin-launchd HostAdapter; the OS-supervision host for
 * standalone `type: agent` bot packages on Linux. Per cortex
 * `docs/design-arc-agent-bots.md` §3.2 platform note: "On Linux the
 * equivalent is systemd user units (`systemctl --user` +
 * `~/.config/systemd/user/`). The bot's `arc-manifest.yaml` declares
 * OS-specific `provides` entries (`provides.plist` for darwin,
 * `provides.systemdUnit` for linux), and arc renders + loads the
 * appropriate one."
 *
 * Detection rule (matches darwin-launchd's file-presence approach):
 *   1. `platform() === "linux"`.
 *   2. `~/.config/systemd/user` exists.
 *
 * A user who has run `systemctl --user` at least once will have this
 * directory present. A stripped container without systemd auto-fails
 * the second check and registers as undetected. We do not stat
 * `systemctl` on PATH for the same reason darwin-launchd skips
 * `launchctl` — the binary is part of the base systemd install, and a
 * sysadmin-stripped layout is exotic enough to defer to install-time
 * error surfacing.
 *
 * Install/remove dispatch (rendering `provides.systemdUnit`, symlinking
 * `provides.binary`, `systemctl --user daemon-reload` + `enable --now` /
 * `disable --now`) lives in `systemd-install.ts` (arc#311, L2) — the
 * systemd sister to `launchd-install.ts`. This file remains the adapter
 * surface only: `id`, `paths`, `detect()`, `supports()`.
 *
 * `supports()` matches darwin-launchd (`agent` + `tool`).
 */

export interface LinuxSystemdHostOptions {
  /** Override `~/.config/systemd/user` (test isolation). */
  unitDir?: string;
  /** Override the shared bin dir (test isolation; shared shim dir). */
  binDir?: string;
  /**
   * Override the platform check. Lets non-linux CI exercise the
   * adapter's path-building and `supports()` logic without skipping
   * the file.
   */
  forcePlatform?: NodeJS.Platform;
}

/** Build linux-systemd host paths rooted at the given directories. */
export function linuxSystemdPaths(
  opts?: LinuxSystemdHostOptions,
): LinuxSystemdHostPaths {
  const home = homedir();
  const unitDir = opts?.unitDir ?? join(home, ".config", "systemd", "user");
  const binDir =
    opts?.binDir ??
    resolveSharedBinDir({ home, platform: opts?.forcePlatform });
  return {
    root: unitDir,
    skillsDir: "",
    agentsDir: "",
    promptsDir: "",
    binDir,
    settingsPath: unitDir,
    unitDir,
  };
}

export function createLinuxSystemdHost(
  opts?: LinuxSystemdHostOptions,
): HostAdapter & { paths: LinuxSystemdHostPaths } {
  const paths = linuxSystemdPaths(opts);
  const onLinux = (opts?.forcePlatform ?? platform()) === "linux";
  return {
    id: "linux-systemd",
    paths,
    detect: () => onLinux && existsSync(paths.unitDir),
    supports: (type: ArtifactType) => type === "agent" || type === "tool",
  };
}

/**
 * Type guard for the linux-systemd host's narrowed paths shape.
 *
 * Sister to `isDarwinLaunchdHost` (darwin-launchd.ts). Use this in
 * multi-target dispatch instead of a blanket `as` cast — if
 * `createLinuxSystemdHost()` is ever refactored to drop the `unitDir`
 * extension, this guard fails fast at runtime with a clear message
 * instead of letting a downstream `.paths.unitDir` access surface as
 * `undefined`. Sage P3 review (arc#143) established the pattern.
 */
export function isLinuxSystemdHost(
  host: HostAdapter,
): host is HostAdapter & { paths: LinuxSystemdHostPaths } {
  return (
    host.id === "linux-systemd" &&
    typeof (host.paths as Partial<LinuxSystemdHostPaths>).unitDir === "string"
  );
}
