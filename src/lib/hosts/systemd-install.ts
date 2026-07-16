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
 * RENDER-ONLY, matching `launchd-install.ts` exactly (principal decision,
 * PR #314 review — supersedes the L2 design's original inline-activation
 * dispatch): install symlinks `provides.binary`, renders `provides.systemdUnit`,
 * and runs `systemctl --user daemon-reload` so systemd sees the new unit
 * file — that's it. Activation (`systemctl --user enable --now`, or
 * whatever the package needs) is the PACKAGE's own `lifecycle.postinstall`
 * concern, exactly like darwin-launchd defers `launchctl bootstrap` to the
 * same mechanism (see that file's header). This restores platform parity
 * and removes the "arbitrary ExecStart goes live sight-unseen" gap by
 * construction — nothing gets ACTIVATED here, so there is no
 * content-level review surface needed in this function.
 *
 * A mid-sequence systemctl failure (daemon-reload) still must undo whatever
 * this call already landed (unit file, binary symlink) itself — the outer
 * `installPerTarget` rollback only unwinds records this function actually
 * RETURNS, and a thrown error never returns one. See `installSystemdArtifacts`
 * for the local cleanup-then-throw discipline that closes that gap.
 *
 * Remove (`removeSystemdArtifacts`) is UNCHANGED by this decision: arc still
 * owns teardown symmetrically, `systemctl --user disable --now` first (in
 * case the package's own postinstall enabled it) — same as darwin remove
 * unloading the plist regardless of who loaded it.
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

/**
 * Hard budget for a single `systemctl`/`loginctl` invocation (default
 * runner/checker only — injected test runners are not subject to this).
 * Closes a real hang: a stuck D-Bus session would otherwise leave
 * `proc.exited` (and the stderr/stdout pipe reads, which only complete on
 * process exit) unresolved forever, hanging `arc install`/`arc remove`
 * indefinitely (arc#311/PR#314 review, MAJOR).
 */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Race a spawned process's output-read + exit-wait against a timeout,
 * killing the process (and so unblocking its pipe reads too) if it fires.
 * Timing out THROWS — callers normalize that the same way they normalize
 * any other spawn failure (`safeRun/safeCheckLinger`), so a hang surfaces
 * as a regular, actionable error instead of wedging the CLI.
 */
export async function withSpawnTimeout<T>(
  proc: { kill(): void },
  work: Promise<T>,
  binName: string,
  ms: number = SPAWN_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${binName} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function defaultSystemctlRunner(args: string[]): Promise<SystemctlResult> {
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return withSpawnTimeout(
    proc,
    (async () => {
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return { code, stderr };
    })(),
    "systemctl",
  );
}

/**
 * Normalize a `SystemctlRunner` call so a THROW (e.g. `Bun.spawn` throwing
 * synchronously on a missing `systemctl` binary — ENOENT — or a
 * `withSpawnTimeout` timeout) takes the EXACT same path as a resolved
 * non-zero exit. Every downstream `.code !== 0` branch then handles both
 * uniformly, and cleanup always runs (arc#311/PR#314 review, BLOCKER: a
 * throwing runner previously bypassed `cleanupPartial()` entirely and
 * propagated uncaught).
 */
async function safeRun(run: SystemctlRunner, args: string[]): Promise<SystemctlResult> {
  try {
    return await run(args);
  } catch (err) {
    return { code: -1, stderr: errorMessage(err) };
  }
}

/**
 * Outcome of a linger check — whether an ENABLED unit will survive logout.
 *
 * NOT consulted by `installSystemdArtifacts` (render-only design, see file
 * header) — arc's install dispatch never enables anything, so it has no
 * STOP-AND-ASK precondition to gate. Kept exported as a seam for the
 * PACKAGE side of the split: a bot's own `lifecycle.postinstall` script is
 * where `systemctl --user enable --now` actually runs, and that is where a
 * linger check belongs. `arc` itself does not currently call this from any
 * command; it is public API for that future package-side use (and for
 * tests that still want to construct a fixed `LingerStatus`).
 */
export interface LingerStatus {
  enabled: boolean;
  username: string;
}

/**
 * Injectable seam for a linger precondition check. See `LingerStatus`'s
 * doc comment for why this lives here unused by the install dispatch.
 */
export type LingerChecker = () => Promise<LingerStatus>;

/** Real `loginctl show-user --property=Linger` query. Timeout-guarded like `defaultSystemctlRunner`. */
export async function defaultLingerChecker(): Promise<LingerStatus> {
  const username = userInfo().username;
  const proc = Bun.spawn(
    ["loginctl", "show-user", username, "--property=Linger", "--value"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return withSpawnTimeout(
    proc,
    (async () => {
      const stdout = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return { enabled: stdout === "yes", username };
    })(),
    "loginctl",
  );
}

/**
 * Normalize a `LingerChecker` call so a THROW fails CLOSED — `enabled:
 * false` — rather than silently reporting linger as confirmed on. Sister to
 * `safeRun`. Exported alongside `defaultLingerChecker` for the same
 * not-yet-wired package-side use.
 */
export async function safeCheckLinger(
  check: LingerChecker,
): Promise<LingerStatus & { checkError?: string }> {
  try {
    return await check();
  } catch (err) {
    return { enabled: false, username: userInfo().username, checkError: errorMessage(err) };
  }
}

/** systemctl's "unit not loaded" family of messages — not a real remove failure. */
function isNotLoadedError(stderr: string): boolean {
  return /not (be )?found|not loaded|does not exist|no such file|not been loaded/i.test(stderr);
}

/**
 * Find any `{{TOKEN}}` markers still present after `renderUnit` substitution
 * (arc#311/PR#314 review, MINOR): a typo'd or unsupported token in
 * `provides.systemdUnit` must not silently reach disk — even under the
 * render-only design (activation deferred to the package's own
 * `lifecycle.postinstall`, see file header), a typo'd token would still
 * ship a broken unit file the package's postinstall then tries to enable
 * blind. Catching it here, before daemon-reload, is strictly better than
 * letting it surface as a confusing `systemctl` failure two steps later
 * inside the package's own script. Deliberately NOT added to the shared
 * `renderTokens` (used by `launchd-install.ts`'s `renderPlist` too) —
 * launchd's permissive unknown-token pass-through is documented,
 * intentional behavior for that host and must not change here.
 */
function findUnrenderedTokens(rendered: string): string[] {
  const matches = rendered.match(/\{\{[A-Za-z0-9_-]+\}\}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Install the linux-systemd-side artifacts of a `type: agent`/`tool`
 * package: symlink `provides.binary` into `host.paths.binDir`, render
 * `provides.systemdUnit` into `host.paths.unitDir`, then
 * `systemctl --user daemon-reload` so systemd sees the new unit file.
 *
 * RENDER-ONLY (see file header) — this function does NOT enable or start
 * the unit. `systemctl --user enable --now` is the package's own
 * `lifecycle.postinstall` responsibility, exactly matching
 * `installLaunchdArtifacts` (which stops at rendering the plist —
 * `launchctl bootstrap` is likewise the bot's postinstall concern).
 *
 * A mid-sequence systemctl failure (daemon-reload) still must undo
 * whatever this call already landed (unit file, binary symlink) itself —
 * the outer `installPerTarget` rollback only unwinds records this
 * function actually RETURNS, and a thrown error never returns one.
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
}): Promise<SystemdInstallRecord> {
  const record: SystemdInstallRecord = {};
  const provides = opts.manifest.provides ?? {};
  const runSystemctl = opts.systemctlRunner ?? defaultSystemctlRunner;

  // Best-effort undo of whatever THIS call has landed so far. See file
  // header: unlike launchd, a daemon-reload failure here must not leak a
  // rendered unit or symlinked binary — this function is its own rollback
  // boundary for that one remaining systemctl step.
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

    // 2b. Unrendered-token gate — BEFORE anything lands on disk. See
    // findUnrenderedTokens' doc comment: a typo'd/unsupported token must
    // not ship to disk, even though nothing gets activated here.
    const unrendered = findUnrenderedTokens(rendered);
    if (unrendered.length) {
      await cleanupPartial();
      throw new Error(
        `provides.systemdUnit '${provides.systemdUnit}' has unrendered token(s) after substitution: ` +
          `${unrendered.join(", ")} — refusing to write a unit with unresolved template markers. ` +
          `Fix the manifest/template and reinstall.`,
      );
    }

    const unitName = basename(provides.systemdUnit);
    const unitTargetPath = join(opts.host.paths.unitDir, unitName);
    await mkdir(dirname(unitTargetPath), { recursive: true });
    await Bun.write(unitTargetPath, rendered);
    record.unitPath = unitTargetPath;
    record.unitName = unitName;
    if (!opts.quiet) {
      console.log(`  ✓ Unit rendered: ${unitTargetPath}`);
    }

    // 3. daemon-reload so systemd sees the freshly-rendered unit file. This
    // is the LAST step — no enable, no linger check (see file header):
    // activation is the package's own lifecycle.postinstall concern.
    // safeRun: a THROW (missing systemctl binary, timeout, …) must hit
    // cleanupPartial() exactly like a resolved non-zero exit does — see
    // safeRun's doc comment (arc#311/PR#314 review, BLOCKER).
    const reload = await safeRun(runSystemctl, ["--user", "daemon-reload"]);
    if (reload.code !== 0) {
      await cleanupPartial();
      throw new Error(
        `systemctl --user daemon-reload failed (exit ${reload.code}): ${reload.stderr.trim()}`,
      );
    }
    if (!opts.quiet) {
      console.log(`  ✓ systemd daemon-reload complete (activation deferred to the package's lifecycle.postinstall)`);
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
 * Best-effort across ALL steps, including the systemctl calls themselves
 * (arc#311/PR#314 review, BLOCKER): every `systemctl` invocation goes
 * through `safeRun`, so a THROW (missing binary, timeout, …) degrades to a
 * logged warning exactly like a non-zero exit — disable, unit unlink,
 * daemon-reload, and binary unlink each proceed independently regardless
 * of whether an earlier step failed. `arc remove` must reach its DB/repo
 * cleanup even when the systemd side is completely wedged.
 */
export async function removeSystemdArtifacts(opts: {
  host: HostAdapter & { paths: LinuxSystemdHostPaths };
  manifest: ArcManifest;
  quiet?: boolean;
  systemctlRunner?: SystemctlRunner;
  /**
   * Skip the `systemctl` calls entirely — used when the caller has already
   * determined (via `host.detect()`) that there is no systemd user session
   * to talk to. File removal (unit + binary symlink) still happens
   * unconditionally; this only suppresses the doomed-to-fail disable/
   * daemon-reload spawn attempts (and their warnings) so remove degrades
   * to one clear message instead of two confusing spawn errors.
   */
  skipSystemctl?: boolean;
}): Promise<SystemdInstallRecord> {
  const removed: SystemdInstallRecord = {};
  const provides = opts.manifest.provides ?? {};
  const runSystemctl = opts.systemctlRunner ?? defaultSystemctlRunner;

  if (provides.systemdUnit) {
    const unitName = basename(provides.systemdUnit);
    const unitPath = join(opts.host.paths.unitDir, unitName);

    if (!opts.skipSystemctl) {
      const disable = await safeRun(runSystemctl, ["--user", "disable", "--now", unitName]);
      if (disable.code !== 0 && !isNotLoadedError(disable.stderr)) {
        console.warn(
          `  ⚠ remove: systemctl --user disable --now ${unitName} exited ${disable.code}: ${disable.stderr.trim()}`,
        );
      }
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

    if (!opts.skipSystemctl) {
      const reload = await safeRun(runSystemctl, ["--user", "daemon-reload"]);
      if (reload.code !== 0) {
        console.warn(
          `  ⚠ remove: systemctl --user daemon-reload failed (exit ${reload.code}): ${reload.stderr.trim()}`,
        );
      }
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
    const disable = await safeRun(runSystemctl, ["--user", "disable", "--now", record.unitName]);
    if (disable.code !== 0 && !isNotLoadedError(disable.stderr)) {
      console.warn(
        `  ⚠ rollback: systemctl --user disable --now ${record.unitName} exited ${disable.code}: ${disable.stderr.trim()}`,
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
    const reload = await safeRun(runSystemctl, ["--user", "daemon-reload"]);
    if (reload.code !== 0) {
      console.warn(`  ⚠ rollback: systemd daemon-reload failed: ${reload.stderr.trim()}`);
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
