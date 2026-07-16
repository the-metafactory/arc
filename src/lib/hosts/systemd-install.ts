import { existsSync } from "fs";
import { mkdir, readFile, unlink } from "fs/promises";
import { homedir, userInfo } from "os";
import { basename, dirname, join } from "path";
import type {
  ArcManifest,
  HostAdapter,
  LinuxSystemdHostPaths,
} from "../../types.js";
import { createSymlink, removeSymlink } from "../symlinks.js";
import { errorMessage, isErrno } from "../errors.js";
import { renderTokens, type TokenMap } from "./render-tokens.js";
import { stateDir } from "../xdg-paths.js";

/**
 * linux-systemd install/remove dispatch (arc#311, L2).
 *
 * Sister to `launchd-install.ts`, with one structural difference: darwin
 * defers `launchctl bootstrap` to the bot's own `lifecycle.postinstall`
 * script (see that file's header), but this dispatch invokes
 * `systemctl --user daemon-reload` + `enable --now` INLINE, per the L2
 * design (cortex `docs/design-arc-agent-bots.md` §3.2 platform note).
 * That means a mid-sequence systemctl failure here must undo whatever this
 * call already landed (unit file, binary symlink) itself — the outer
 * `installPerTarget` rollback only unwinds records this function actually
 * RETURNS, and a thrown error never returns one. See `installSystemdArtifacts`
 * for the local cleanup-then-throw discipline that closes that gap.
 *
 * Do NOT generalize `SystemdInstallRecord`/`LaunchdInstallRecord` into one
 * shared record type in this PR (spec open-question 1, arc#311): keep them
 * as sister types until a third supervision host exists.
 */

/** Token substitution map for systemd unit rendering. Sister to `LaunchdTokens`. */
export type SystemdTokens = TokenMap;

/**
 * Compute default token values used during unit rendering.
 *
 * - `{{BIN}}` → absolute path of the symlinked binary (after install)
 * - `{{INSTALL_PATH}}` → the cloned-package directory
 * - `{{HOME}}` → `os.homedir()`
 * - `{{LOG_DIR}}` → `~/.local/state/metafactory/<package-name>/log`
 *   (XDG state dir, arc#293/#1868 — the Linux analog of launchd's
 *   `~/Library/Logs/<package-name>/`)
 * - `{{UNIT_DIR}}` → `host.paths.unitDir` (linux has no launchd equivalent
 *   since the plist doesn't reference its own containing directory)
 * - `{{NATS_URL}}` → `process.env.NATS_URL` or `nats://127.0.0.1:4222`
 *
 * Callers may pass `extra` to override or extend.
 */
export function buildSystemdTokens(opts: {
  installPath: string;
  packageName: string;
  unitDir: string;
  binaryAbsPath?: string;
  extra?: SystemdTokens;
}): SystemdTokens {
  const home = homedir();
  const base: SystemdTokens = {
    BIN: opts.binaryAbsPath ?? "",
    INSTALL_PATH: opts.installPath,
    HOME: home,
    LOG_DIR: join(stateDir(opts.packageName), "log"),
    UNIT_DIR: opts.unitDir,
    NATS_URL: process.env.NATS_URL ?? "nats://127.0.0.1:4222",
  };
  return { ...base, ...(opts.extra ?? {}) };
}

/**
 * Render a systemd unit template by substituting `{{TOKEN}}` markers.
 * Delegates to the shared `renderTokens` (arc#311) — identical grammar to
 * `launchd-install.ts`'s `renderPlist`.
 */
export function renderUnit(template: string, tokens: SystemdTokens): string {
  return renderTokens(template, tokens);
}

/**
 * Aggregate of artifacts created by the linux-systemd install pass.
 * Sister to `LaunchdInstallRecord` (`unitPath`/`unitName` instead of
 * `plistPath`) — captured so both the in-function cleanup-on-failure path
 * and the multi-target rollback (`installPerTarget` / `InstallTransaction`)
 * can reverse them cleanly.
 */
export interface SystemdInstallRecord {
  /** Absolute path of the binary symlink (into `host.paths.binDir`). */
  binSymlink?: string;
  /** Absolute path of `<unitDir>/<unit-name>.service`. */
  unitPath?: string;
  /** Basename of the rendered unit file (the `systemctl` unit name). */
  unitName?: string;
}

/** Result of a single `systemctl` invocation. Matches the issue-specified shape. */
export interface SystemctlResult {
  code: number;
  stderr: string;
}

/**
 * Injectable seam for `systemctl --user <args>` invocations. Production
 * uses the real spawn (`defaultSystemctlRunner`); unit tests inject a
 * recorder so NO test ever spawns a real `systemctl` process (arc#311
 * requirement — this repo's dev/CI machines are not all systemd-user
 * capable, e.g. macOS).
 */
export type SystemctlRunner = (args: string[]) => Promise<SystemctlResult>;

async function defaultSystemctlRunner(args: string[]): Promise<SystemctlResult> {
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

/** Outcome of a linger check — whether `enable --now` is safe to run. */
export interface LingerStatus {
  enabled: boolean;
  username: string;
}

/**
 * Injectable seam for the linger precondition check (see
 * `installSystemdArtifacts` step 4 doc comment for why this exists).
 * Production queries `loginctl` for real; unit tests inject a fixed
 * result so no real `loginctl` process is spawned either.
 */
export type LingerChecker = () => Promise<LingerStatus>;

async function defaultLingerChecker(): Promise<LingerStatus> {
  const username = userInfo().username;
  const proc = Bun.spawn(
    ["loginctl", "show-user", username, "--property=Linger", "--value"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return { enabled: stdout === "yes", username };
}

/** systemctl's "unit not loaded" family of messages — not a real remove failure. */
function isNotLoadedError(stderr: string): boolean {
  return /not (be )?found|not loaded|does not exist|no such file|not been loaded/i.test(stderr);
}

/**
 * Install the linux-systemd-side artifacts of a `type: agent`/`tool`
 * package: symlink `provides.binary` into `host.paths.binDir`, render
 * `provides.systemdUnit` into `host.paths.unitDir`, then
 * `systemctl --user daemon-reload` and `systemctl --user enable --now`.
 *
 * Unlike `installLaunchdArtifacts` (which stops at rendering the plist —
 * `launchctl bootstrap` is the bot's own `lifecycle.postinstall` concern),
 * this function owns the `systemctl` calls itself per the L2 design. That
 * means it also owns cleanup on a mid-sequence failure: every step past
 * the first records what it created, and any subsequent throw first
 * removes what THIS call landed (unit file, binary symlink) before
 * throwing, so a caught error never leaves an orphan for the outer
 * `installPerTarget` rollback to miss.
 *
 * STOP-AND-ASK (arc#311, principal-authored constraint): `enable --now`
 * persisting a user unit across logout requires systemd "linger" for the
 * account (`loginctl enable-linger <user>`). Without it the daemon dies
 * the moment the install session ends — silently defeating the point of
 * installing a supervised daemon. arc never invokes `sudo` itself, so
 * when linger is off this throws with the exact command for the operator
 * to run, rather than proceeding into a service that looks installed but
 * won't survive logout.
 *
 * Returns the record so a later failure elsewhere in the install can roll
 * back the systemd side of the multi-target install (see
 * `rollbackSystemdArtifacts` / `install-transaction.ts`).
 */
export async function installSystemdArtifacts(opts: {
  host: HostAdapter & { paths: LinuxSystemdHostPaths };
  manifest: ArcManifest;
  installDir: string;
  /** Suppress console output (for non-interactive / test use). */
  quiet?: boolean;
  /** Extra token overrides for unit rendering (test isolation). */
  tokens?: SystemdTokens;
  /** Injectable systemctl seam (test isolation — never spawns for real in tests). */
  systemctlRunner?: SystemctlRunner;
  /** Injectable linger-check seam (test isolation). */
  lingerChecker?: LingerChecker;
}): Promise<SystemdInstallRecord> {
  const record: SystemdInstallRecord = {};
  const provides = opts.manifest.provides ?? {};
  const runSystemctl = opts.systemctlRunner ?? defaultSystemctlRunner;
  const checkLinger = opts.lingerChecker ?? defaultLingerChecker;

  // Best-effort undo of whatever THIS call has landed so far. See file
  // header: unlike launchd, a failure past unit-render here (daemon-reload,
  // linger gate, enable --now) must not leak a rendered unit or symlinked
  // binary — this function is its own rollback boundary for those steps.
  const cleanupPartial = async () => {
    if (record.unitPath) {
      try {
        await unlink(record.unitPath);
      } catch (err) {
        if (isErrno(err) && err.code !== "ENOENT") {
          console.warn(
            `  ⚠ install: failed to clean up partial systemd unit ${record.unitPath}: ${errorMessage(err)}`,
          );
        }
      }
    }
    if (record.binSymlink) {
      try {
        await removeSymlink(record.binSymlink);
      } catch (err) {
        if (isErrno(err) && err.code !== "ENOENT") {
          console.warn(
            `  ⚠ install: failed to clean up partial systemd binary symlink ${record.binSymlink}: ${errorMessage(err)}`,
          );
        }
      }
    }
  };

  // 1. Install the binary (symlink into host.binDir).
  if (provides.binary) {
    const sourceBinPath = join(opts.installDir, provides.binary);
    if (!existsSync(sourceBinPath)) {
      throw new Error(
        `provides.binary '${provides.binary}' does not exist in the package at ${sourceBinPath}`,
      );
    }
    const binName = basename(provides.binary);
    const binLinkPath = join(opts.host.paths.binDir, binName);
    await mkdir(opts.host.paths.binDir, { recursive: true });
    await createSymlink(sourceBinPath, binLinkPath);
    record.binSymlink = binLinkPath;
    if (!opts.quiet) {
      console.log(`  ✓ Binary linked: ${binLinkPath}`);
    }
  }

  // 2. Render the unit (token substitution) and write into unitDir.
  if (provides.systemdUnit) {
    const sourceUnitPath = join(opts.installDir, provides.systemdUnit);
    if (!existsSync(sourceUnitPath)) {
      await cleanupPartial();
      throw new Error(
        `provides.systemdUnit '${provides.systemdUnit}' does not exist in the package at ${sourceUnitPath}`,
      );
    }
    const template = await readFile(sourceUnitPath, "utf-8");

    const tokens = buildSystemdTokens({
      installPath: opts.installDir,
      packageName: opts.manifest.name,
      unitDir: opts.host.paths.unitDir,
      binaryAbsPath: record.binSymlink,
      extra: opts.tokens,
    });
    const rendered = renderUnit(template, tokens);

    const unitName = basename(provides.systemdUnit);
    const unitTargetPath = join(opts.host.paths.unitDir, unitName);
    await mkdir(dirname(unitTargetPath), { recursive: true });
    await Bun.write(unitTargetPath, rendered);
    record.unitPath = unitTargetPath;
    record.unitName = unitName;
    if (!opts.quiet) {
      console.log(`  ✓ Unit rendered: ${unitTargetPath}`);
    }

    // 3. daemon-reload so systemd picks up the freshly-rendered unit file.
    const reload = await runSystemctl(["--user", "daemon-reload"]);
    if (reload.code !== 0) {
      await cleanupPartial();
      throw new Error(
        `systemctl --user daemon-reload failed (exit ${reload.code}): ${reload.stderr.trim()}`,
      );
    }

    // 4. STOP-AND-ASK: see doc comment above. Check linger BEFORE enabling
    // so a disabled-linger account never ends up with a unit that LOOKS
    // enabled but silently stops at logout.
    const linger = await checkLinger();
    if (!linger.enabled) {
      await cleanupPartial();
      throw new Error(
        `linux-systemd install for '${opts.manifest.name}' requires linger enabled for user ` +
          `'${linger.username}' so the '${unitName}' unit survives logout. arc never invokes ` +
          `sudo — run this yourself, then re-run the install:\n` +
          `  sudo loginctl enable-linger ${linger.username}`,
      );
    }

    const enable = await runSystemctl(["--user", "enable", "--now", unitName]);
    if (enable.code !== 0) {
      // Best-effort undo of a partial enable/start before removing the unit
      // file — enable --now can fail after having already enabled (but not
      // started) the unit, or vice versa.
      try {
        await runSystemctl(["--user", "disable", "--now", unitName]);
      } catch {
        // best-effort; the unit file removal below is the load-bearing cleanup.
      }
      await cleanupPartial();
      throw new Error(
        `systemctl --user enable --now ${unitName} failed (exit ${enable.code}): ${enable.stderr.trim()}`,
      );
    }
    if (!opts.quiet) {
      console.log(`  ✓ Unit enabled + started: ${unitName}`);
    }
  }

  return record;
}

/**
 * Reverse the linux-systemd-side install at uninstall time.
 *
 * Symmetric to `installSystemdArtifacts`: `systemctl --user disable --now`
 * (a not-loaded unit is not an error — e.g. cleaning up after a failed
 * install that never reached `enable`), delete the unit file,
 * `daemon-reload`, then remove the binary symlink from `host.binDir`.
 *
 * Best-effort across all steps: an ENOENT on the unit/symlink path is
 * swallowed (idempotent removal), non-ENOENT errors surface via
 * console.warn so the user sees orphans they need to inspect manually.
 */
export async function removeSystemdArtifacts(opts: {
  host: HostAdapter & { paths: LinuxSystemdHostPaths };
  manifest: ArcManifest;
  quiet?: boolean;
  systemctlRunner?: SystemctlRunner;
}): Promise<SystemdInstallRecord> {
  const removed: SystemdInstallRecord = {};
  const provides = opts.manifest.provides ?? {};
  const runSystemctl = opts.systemctlRunner ?? defaultSystemctlRunner;

  if (provides.systemdUnit) {
    const unitName = basename(provides.systemdUnit);
    const unitPath = join(opts.host.paths.unitDir, unitName);

    const disable = await runSystemctl(["--user", "disable", "--now", unitName]);
    if (disable.code !== 0 && !isNotLoadedError(disable.stderr)) {
      console.warn(
        `  ⚠ remove: systemctl --user disable --now ${unitName} exited ${disable.code}: ${disable.stderr.trim()}`,
      );
    }

    try {
      await unlink(unitPath);
      removed.unitPath = unitPath;
      removed.unitName = unitName;
      if (!opts.quiet) {
        console.log(`  ✓ Unit removed: ${unitPath}`);
      }
    } catch (err) {
      if (isErrno(err) && err.code !== "ENOENT") {
        console.warn(
          `  ⚠ remove: failed to unlink systemd unit ${unitPath}: ${errorMessage(err)}`,
        );
      }
    }

    const reload = await runSystemctl(["--user", "daemon-reload"]);
    if (reload.code !== 0) {
      console.warn(
        `  ⚠ remove: systemctl --user daemon-reload failed (exit ${reload.code}): ${reload.stderr.trim()}`,
      );
    }
  }

  if (provides.binary) {
    const binName = basename(provides.binary);
    const binLinkPath = join(opts.host.paths.binDir, binName);
    try {
      await unlink(binLinkPath);
      removed.binSymlink = binLinkPath;
      if (!opts.quiet) {
        console.log(`  ✓ Binary unlinked: ${binLinkPath}`);
      }
    } catch (err) {
      if (isErrno(err) && err.code !== "ENOENT") {
        console.warn(
          `  ⚠ remove: failed to unlink systemd binary ${binLinkPath}: ${errorMessage(err)}`,
        );
      }
    }
  }

  return removed;
}

/**
 * Reverse {@link installSystemdArtifacts} from a captured record — used by
 * the multi-target install rollback (`installPerTarget` in
 * `commands/install.ts`) and `InstallTransaction.rollback()`
 * (`install-transaction.ts`) when a LATER install step fails after the
 * systemd side has already landed.
 *
 * Best-effort across all steps, matching `rollbackLaunchdArtifacts`'s
 * warn-and-continue discipline: an ENOENT on one artifact doesn't abort
 * cleanup of the others.
 */
export async function rollbackSystemdArtifacts(
  record: SystemdInstallRecord,
  opts?: { systemctlRunner?: SystemctlRunner },
): Promise<void> {
  const runSystemctl = opts?.systemctlRunner ?? defaultSystemctlRunner;

  if (record.unitName) {
    try {
      const disable = await runSystemctl(["--user", "disable", "--now", record.unitName]);
      if (disable.code !== 0 && !isNotLoadedError(disable.stderr)) {
        console.warn(
          `  ⚠ rollback: systemctl --user disable --now ${record.unitName} exited ${disable.code}: ${disable.stderr.trim()}`,
        );
      }
    } catch (err) {
      console.warn(
        `  ⚠ rollback: failed to disable systemd unit ${record.unitName}: ${errorMessage(err)}`,
      );
    }
  }
  if (record.unitPath) {
    try {
      await unlink(record.unitPath);
    } catch (err) {
      if (isErrno(err) && err.code !== "ENOENT") {
        console.warn(
          `  ⚠ rollback: failed to remove systemd unit ${record.unitPath}: ${errorMessage(err)}`,
        );
      }
    }
  }
  if (record.unitName) {
    try {
      await runSystemctl(["--user", "daemon-reload"]);
    } catch (err) {
      console.warn(`  ⚠ rollback: systemd daemon-reload failed: ${errorMessage(err)}`);
    }
  }
  if (record.binSymlink) {
    try {
      await removeSymlink(record.binSymlink);
    } catch (err) {
      if (isErrno(err) && err.code !== "ENOENT") {
        console.warn(
          `  ⚠ rollback: failed to remove systemd binary symlink ${record.binSymlink}: ${errorMessage(err)}`,
        );
      }
    }
  }
}
