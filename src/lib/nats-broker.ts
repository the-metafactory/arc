/**
 * NATS broker bootstrap helper — arc#152.
 *
 * Treats the NATS broker as a declared runtime dependency for packages that
 * route over the message bus (sage, pilot, myelin-consumers, …). Before
 * those packages install or upgrade, arc:
 *
 *   1. Probes the configured broker URL (`NATS_URL` or default
 *      `nats://127.0.0.1:4222`) via a short-timeout TCP connect.
 *   2. If reachable → noop.
 *   3. If unreachable AND `NATS_URL` is unset → bootstrap a local broker
 *      with the platform's package manager:
 *        - macOS: `brew install nats-server` (idempotent) + `brew services
 *          start nats-server` (registers for auto-start across reboots).
 *        - Linux: best-effort `apt-get install -y nats-server` (when apt is
 *          present) followed by a systemd user unit. The Linux path is
 *          conservative — if any step fails, we surface a clear actionable
 *          error rather than partial-bootstrapping.
 *   4. If unreachable AND `NATS_URL` is set → return an error. The operator
 *      explicitly asked for a remote broker; arc must not silently bring
 *      up a local one and override that intent.
 *   5. Idempotent: re-running on a machine where the broker is already up
 *      is a noop.
 *
 * The pattern mirrors `src/commands/nats.ts` (NSC bot identity provisioning):
 * production calls go through `Bun.spawnSync`; tests swap a runner through
 * `__setSpawnRunnerForTests` (gated on `ARC_TEST_MODE=1` / `NODE_ENV=test`)
 * so we don't shell out during unit tests.
 */

import * as net from "node:net";
import { platform } from "node:os";

/** Default broker URL when `NATS_URL` is unset. */
export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";

/** TCP probe timeout — short, because a local broker should answer fast. */
const PROBE_TIMEOUT_MS = 500;

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnRunner = (cmd: string[]) => SpawnResult;
export type Probe = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
export type PlatformFn = () => NodeJS.Platform;

const defaultSpawnRunner: SpawnRunner = (cmd) => {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const defaultProbe: Probe = (host, port, timeoutMs = PROBE_TIMEOUT_MS) =>
  new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { finish(true); });
    socket.once("error", () => { finish(false); });
    socket.once("timeout", () => { finish(false); });
    socket.connect(port, host);
  });

const defaultPlatform: PlatformFn = () => platform();

let spawnRunner: SpawnRunner = defaultSpawnRunner;
let probe: Probe = defaultProbe;
let platformFn: PlatformFn = defaultPlatform;

function assertTestMode(seam: string): void {
  if (process.env.ARC_TEST_MODE !== "1" && process.env.NODE_ENV !== "test") {
    throw new Error(`${seam} is a test-only seam. Set ARC_TEST_MODE=1 or NODE_ENV=test.`);
  }
}

/** Test-only seam: swap the spawn runner. Pass `null` to restore default. */
export function __setSpawnRunnerForTests(next: SpawnRunner | null): void {
  assertTestMode("__setSpawnRunnerForTests");
  spawnRunner = next ?? defaultSpawnRunner;
}

/** Test-only seam: swap the TCP probe. Pass `null` to restore default. */
export function __setProbeForTests(next: Probe | null): void {
  assertTestMode("__setProbeForTests");
  probe = next ?? defaultProbe;
}

/** Test-only seam: swap the platform detector. Pass `null` to restore default. */
export function __setPlatformForTests(next: PlatformFn | null): void {
  assertTestMode("__setPlatformForTests");
  platformFn = next ?? defaultPlatform;
}

/**
 * Parse `nats://host:port` (or bare `host:port` / `host`) into endpoint parts.
 * Falls back to default port 4222 when the URL omits one.
 */
export function parseNatsUrl(url: string): { host: string; port: number } {
  const stripped = url.replace(/^nats:\/\//, "").replace(/\/.*$/, "");
  const lastColon = stripped.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: stripped, port: 4222 };
  }
  const host = stripped.slice(0, lastColon);
  const portStr = stripped.slice(lastColon + 1);
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port)) {
    // Malformed port → use the host part and fall back to the default port
    // rather than treating the whole `host:abc` as a hostname.
    return { host, port: 4222 };
  }
  return { host, port };
}

export type EnsureBrokerStatus =
  | "already-running"
  | "bootstrapped"
  | "remote-unreachable"
  | "bootstrap-failed"
  | "unsupported-platform";

export interface EnsureBrokerResult {
  ok: boolean;
  status: EnsureBrokerStatus;
  url: string;
  message: string;
  /** True when `NATS_URL` was set in the env (operator-specified remote). */
  remoteRequested: boolean;
}

export interface EnsureBrokerOptions {
  /** Suppress informational stdout (used by `--yes` install flow). */
  quiet?: boolean;
  /** Override env lookup — test seam. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Verify a NATS broker is reachable for packages that declare `requires.nats`.
 * Bootstraps a local broker when allowed; surfaces a clear error otherwise.
 *
 * Never throws — returns a structured result so the install path can decide
 * how to surface the failure (abort the install vs. continue with a warning).
 * Today the install flow treats `ok: false` as a hard abort.
 */
export async function ensureBroker(
  opts: EnsureBrokerOptions = {},
): Promise<EnsureBrokerResult> {
  const env = opts.env ?? process.env;
  const envUrl = env.NATS_URL;
  const remoteRequested = typeof envUrl === "string" && envUrl.length > 0;
  const url = remoteRequested ? envUrl : DEFAULT_NATS_URL;
  const { host, port } = parseNatsUrl(url);

  const reachable = await probe(host, port);
  if (reachable) {
    if (!opts.quiet) {
      console.log(`  ✓ NATS broker present at ${url}`);
    }
    return {
      ok: true,
      status: "already-running",
      url,
      message: `broker reachable at ${url}`,
      remoteRequested,
    };
  }

  if (remoteRequested) {
    return {
      ok: false,
      status: "remote-unreachable",
      url,
      message:
        `NATS_URL=${url} is set but the broker is unreachable. ` +
        `arc will not auto-bootstrap when a remote broker is explicitly configured — ` +
        `start the remote broker, fix connectivity, or unset NATS_URL to bootstrap locally.`,
      remoteRequested,
    };
  }

  // No remote configured + local unreachable → bootstrap path
  const plat = platformFn();
  if (plat === "darwin") {
    return bootstrapDarwin(url, opts.quiet);
  }
  if (plat === "linux") {
    return bootstrapLinux(url, opts.quiet);
  }

  return {
    ok: false,
    status: "unsupported-platform",
    url,
    message:
      `Auto-bootstrap of NATS broker not supported on platform '${plat}'. ` +
      `Install nats-server manually and re-run, or set NATS_URL to a running broker.`,
    remoteRequested,
  };
}

function which(cmd: string): boolean {
  const r = spawnRunner(["which", cmd]);
  return r.exitCode === 0;
}

function bootstrapDarwin(url: string, quiet?: boolean): EnsureBrokerResult {
  if (!which("brew")) {
    return {
      ok: false,
      status: "bootstrap-failed",
      url,
      message:
        `Homebrew not found on PATH — cannot auto-install nats-server. ` +
        `Install Homebrew (https://brew.sh) or set NATS_URL to a running broker.`,
      remoteRequested: false,
    };
  }

  if (!quiet) console.log("  ⤵ NATS broker not running — installing via Homebrew...");

  const installRes = spawnRunner(["brew", "install", "nats-server"]);
  if (installRes.exitCode !== 0) {
    return {
      ok: false,
      status: "bootstrap-failed",
      url,
      message: `brew install nats-server failed: ${installRes.stderr.trim() || installRes.stdout.trim()}`,
      remoteRequested: false,
    };
  }

  // `brew services start` writes a launchd plist so the broker survives reboot.
  // This is the gap that caused arc#152 — manual `nats-server &` dies on reboot.
  const startRes = spawnRunner(["brew", "services", "start", "nats-server"]);
  if (startRes.exitCode !== 0) {
    return {
      ok: false,
      status: "bootstrap-failed",
      url,
      message:
        `brew services start nats-server failed: ${startRes.stderr.trim() || startRes.stdout.trim()}. ` +
        `Retry manually: brew services start nats-server`,
      remoteRequested: false,
    };
  }

  if (!quiet) console.log("  ✓ NATS broker bootstrapped via Homebrew, registered for auto-start");

  return {
    ok: true,
    status: "bootstrapped",
    url,
    message: `bootstrapped local nats-server via brew, registered with brew services for auto-start`,
    remoteRequested: false,
  };
}

function bootstrapLinux(url: string, quiet?: boolean): EnsureBrokerResult {
  // Linux conservatively: only proceed when systemctl --user is present.
  // We do NOT auto-`apt-get install` because that needs root and would surprise
  // operators who keep nats-server in a non-package location. Surface a clear
  // actionable error instead — same pattern as arc's other host adapters.
  if (!which("systemctl")) {
    return {
      ok: false,
      status: "bootstrap-failed",
      url,
      message:
        `Linux auto-bootstrap requires systemctl. Install nats-server manually ` +
        `(https://docs.nats.io/running-a-nats-service/introduction/installation) ` +
        `and either start it now or set NATS_URL to a running broker.`,
      remoteRequested: false,
    };
  }

  if (!which("nats-server")) {
    return {
      ok: false,
      status: "bootstrap-failed",
      url,
      message:
        `nats-server binary not found on PATH. Install it ` +
        `(https://docs.nats.io/running-a-nats-service/introduction/installation) ` +
        `and re-run, or set NATS_URL to a running broker.`,
      remoteRequested: false,
    };
  }

  if (!quiet) console.log("  ⤵ NATS broker not running — enabling via systemd user unit...");

  // systemd user unit name is conventionally `nats-server.service`. We don't
  // ship a unit file from arc — operators that install via the OS package
  // already have one. If the unit isn't recognized, fall back to a clear error.
  const enableRes = spawnRunner(["systemctl", "--user", "enable", "--now", "nats-server.service"]);
  if (enableRes.exitCode !== 0) {
    return {
      ok: false,
      status: "bootstrap-failed",
      url,
      message:
        `systemctl --user enable --now nats-server.service failed: ` +
        `${enableRes.stderr.trim() || enableRes.stdout.trim()}. ` +
        `Install a nats-server systemd user unit and retry, or set NATS_URL to a running broker.`,
      remoteRequested: false,
    };
  }

  if (!quiet) console.log("  ✓ NATS broker enabled via systemd user unit");

  return {
    ok: true,
    status: "bootstrapped",
    url,
    message: `bootstrapped local nats-server via systemd user unit (auto-start enabled)`,
    remoteRequested: false,
  };
}
