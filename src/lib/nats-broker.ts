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
 *      via the platform's service manager:
 *        - macOS: `brew install nats-server` (idempotent) + `brew services
 *          start nats-server` (registers for auto-start across reboots).
 *        - Linux: requires an existing `nats-server` binary plus a systemd
 *          user unit; arc runs `systemctl --user enable --now nats-server.service`
 *          to start + register it for auto-start. arc does NOT auto-`apt-get
 *          install` — that would need root and surprise operators with custom
 *          install paths. Missing binary / missing unit / unsupported runtime
 *          → clear actionable error rather than partial-bootstrapping.
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
 * Falls back to default port 4222 when the URL omits one or when the port
 * is unparseable / out of range.
 *
 * Handles `nats://user:pass@host:port` correctly — sage cycle-2 important
 * finding: the original regex-strip + `lastIndexOf(":")` parser treated
 * the auth `user:pass@host` as the host segment, breaking valid
 * operator-supplied URLs with embedded credentials. The WHATWG `URL`
 * parser handles scheme + auth + host + port in one shot; the bare-
 * `host:port` fallback preserves callers that pass a non-scheme string.
 *
 * Port validation — sage cycle-2 security finding: any parsed integer
 * used to reach `socket.connect(port, host)`, which throws on out-of-
 * range values (e.g. `999999`) and surfaces as an unstructured crash
 * rather than the documented `bootstrap-failed` result. Reject ports
 * outside 1-65535 by falling back to the default — same posture as the
 * NaN branch.
 */
export function parseNatsUrl(url: string): { host: string; port: number } {
  const isValidPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;
  // Strip URL-style brackets from IPv6 host literals. WHATWG `hostname`
  // returns `"[::1]"` for `nats://[::1]:4222`, but `net.Socket.connect`
  // expects the bare address `"::1"` — sage cycle-4 IPv6 parse finding.
  const stripIpv6 = (h: string): string =>
    h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  // Scheme URLs go through the WHATWG parser. Convert `nats://` → `tcp://`
  // because WHATWG's URL parser rejects unknown schemes for hostname
  // extraction on some runtimes; `tcp://` is treated as a generic special
  // scheme and the hostname / port surface cleanly.
  if (/^nats:\/\//.test(url)) {
    try {
      const parsed = new URL(url.replace(/^nats:/, "tcp:"));
      const host = stripIpv6(parsed.hostname);
      const portStr = parsed.port;
      if (portStr === "") return { host, port: 4222 };
      const port = parseInt(portStr, 10);
      return isValidPort(port) ? { host, port } : { host, port: 4222 };
    } catch {
      // Malformed scheme URL → fall through to bare-form parser below
      // rather than throwing from the probe path.
    }
  }
  // Bare `host:port` / `host` fallback.
  const stripped = url.replace(/^nats:\/\//, "").replace(/\/.*$/, "");
  const lastColon = stripped.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: stripIpv6(stripped), port: 4222 };
  }
  const host = stripIpv6(stripped.slice(0, lastColon));
  const portStr = stripped.slice(lastColon + 1);
  const port = parseInt(portStr, 10);
  if (!isValidPort(port)) {
    return { host, port: 4222 };
  }
  return { host, port };
}

/**
 * Redact embedded credentials from a NATS URL before printing/logging.
 *
 * Sage cycle-4 security finding: `nats://user:pass@host:4222` flowed
 * verbatim into the success-path stdout (`✓ NATS broker present at ${url}`)
 * and the remote-unreachable error message (`NATS_URL=${url} is set but
 * the broker is unreachable`). Operators piping stderr into log
 * aggregators or pasting install errors into chat would leak the
 * password.
 *
 * Behaviour:
 *   - WHATWG-parseable URLs: rebuild with `username`/`password` stripped.
 *   - Bare-form / un-parseable: regex-strip the `user:pass@` segment.
 *   - Falls through gracefully if neither matches.
 */
export function redactNatsUrl(url: string): string {
  try {
    const parsed = new URL(url.replace(/^nats:/, "tcp:"));
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString().replace(/^tcp:/, "nats:");
    }
    return url;
  } catch {
    return url.replace(/(\w+:\/\/)[^@/]+@/, "$1");
  }
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
      console.log(`  ✓ NATS broker present at ${redactNatsUrl(url)}`);
    }
    return {
      ok: true,
      status: "already-running",
      url,
      message: `broker reachable at ${redactNatsUrl(url)}`,
      remoteRequested,
    };
  }

  if (remoteRequested) {
    return {
      ok: false,
      status: "remote-unreachable",
      url,
      message:
        `NATS_URL=${redactNatsUrl(url)} is set but the broker is unreachable. ` +
        `arc will not auto-bootstrap when a remote broker is explicitly configured — ` +
        `start the remote broker, fix connectivity, or unset NATS_URL to bootstrap locally.`,
      remoteRequested,
    };
  }

  // No remote configured + local unreachable → bootstrap path
  const plat = platformFn();
  if (plat === "darwin") {
    return await bootstrapDarwin(url, opts.quiet);
  }
  if (plat === "linux") {
    return await bootstrapLinux(url, opts.quiet);
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

/**
 * Post-bootstrap reachability check. Sage cycle-1 important finding:
 * `brew services start` (and `systemctl --user enable --now`) can return
 * exit 0 before the broker's TCP listener is actually accepting
 * connections, so a downstream `arc install` step can still hit
 * "connection refused" against a freshly-bootstrapped broker. Probe with
 * a short retry/backoff loop so the bootstrap success path returns
 * `ok: true` only after the broker is observably reachable; otherwise
 * surface a `bootstrap-failed` result with the manual recovery command.
 *
 * Total wait bound: ~6 attempts × 200ms initial + linear backoff to
 * ~1s ≈ 3.5s worst case. Local nats-server reaches readiness within
 * a few hundred ms; this is paranoia, not regular runtime.
 */
async function awaitBrokerReady(url: string, manualCommand: string): Promise<EnsureBrokerResult | null> {
  const { host, port } = parseNatsUrl(url);
  const backoffsMs = [200, 300, 500, 700, 1000, 1000];
  for (const wait of backoffsMs) {
    await new Promise((r) => setTimeout(r, wait));
    const reachable = await probe(host, port);
    if (reachable) return null; // null = success, caller proceeds
  }
  return {
    ok: false,
    status: "bootstrap-failed",
    url,
    message:
      `Bootstrap command returned success but the broker at ${redactNatsUrl(url)} did not become reachable ` +
      `within ${backoffsMs.reduce((a, b) => a + b, 0)}ms. ` +
      `Inspect the service log and retry manually: ${manualCommand}`,
    remoteRequested: false,
  };
}

async function bootstrapDarwin(url: string, quiet?: boolean): Promise<EnsureBrokerResult> {
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

  // Sage cycle-1 fix: confirm reachability before declaring success —
  // `brew services start` exits 0 before launchd has fully started the
  // process, so a downstream install step can still hit "connection
  // refused" against an apparently-bootstrapped broker.
  const readinessFailure = await awaitBrokerReady(url, "brew services start nats-server");
  if (readinessFailure !== null) return readinessFailure;

  if (!quiet) console.log("  ✓ NATS broker bootstrapped via Homebrew, registered for auto-start");

  return {
    ok: true,
    status: "bootstrapped",
    url,
    message: `bootstrapped local nats-server via brew, registered with brew services for auto-start`,
    remoteRequested: false,
  };
}

async function bootstrapLinux(url: string, quiet?: boolean): Promise<EnsureBrokerResult> {
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

  // Sage cycle-1 fix: same reasoning as the darwin path — `systemctl --user
  // enable --now` returns success once the unit is started but the broker
  // may not yet be accepting connections.
  const readinessFailure = await awaitBrokerReady(
    url,
    "systemctl --user enable --now nats-server.service",
  );
  if (readinessFailure !== null) return readinessFailure;

  if (!quiet) console.log("  ✓ NATS broker enabled via systemd user unit");

  return {
    ok: true,
    status: "bootstrapped",
    url,
    message: `bootstrapped local nats-server via systemd user unit (auto-start enabled)`,
    remoteRequested: false,
  };
}

/**
 * Minimal manifest projection needed to decide whether the broker gate
 * applies. Inline shape (rather than importing the full ArcManifest type)
 * keeps this lib decoupled from `src/types.ts` — the broker helper has
 * no reason to know about every other arc-manifest field.
 */
export interface BrokerGateManifest {
  name: string;
  requires?: { nats?: boolean };
}

export interface BrokerGateContext {
  /** Suppress informational stdout — typically the `--yes` install flow. */
  quiet?: boolean;
  /**
   * Caller-shape used in the error string: "Package" for top-level
   * `install`/`upgrade`, "Artifact" for per-library installs. Pure
   * display — the structured failure result still carries the raw
   * `EnsureBrokerResult.message` for callers that want detail.
   */
  noun?: "Package" | "Artifact";
  /** Additional clause appended to the error message (e.g. "during upgrade"). */
  contextClause?: string;
}

export type BrokerGateOutcome =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Shared gate for `arc install` / `arc upgrade` / `installSingleArtifact`.
 * Returns `{ ok: true }` when the manifest doesn't require a broker or
 * when `ensureBroker` succeeds; returns a formatted `error` string
 * otherwise so callers compose it into their own InstallResult /
 * UpgradeResult shape.
 *
 * Sage cycle-1 Maintainability suggestion: centralises the three near-
 * duplicate sites that build the same `${noun} '${name}' requires a
 * running NATS broker…` failure message.
 */
export async function requireBrokerForManifest(
  manifest: BrokerGateManifest,
  ctx: BrokerGateContext = {},
): Promise<BrokerGateOutcome> {
  if (!manifest.requires?.nats) return { ok: true };
  const opts: EnsureBrokerOptions = ctx.quiet === undefined ? {} : { quiet: ctx.quiet };
  const brokerResult = await ensureBroker(opts);
  if (brokerResult.ok) return { ok: true };
  const noun = ctx.noun ?? "Package";
  const clause = ctx.contextClause ?? "";
  return {
    ok: false,
    error:
      `${noun} '${manifest.name}' requires a running NATS broker (requires.nats: true), ` +
      `but arc could not verify or bootstrap one${clause}. ${brokerResult.message}`,
  };
}
