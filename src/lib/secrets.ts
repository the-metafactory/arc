/**
 * F-6e (arc#229) — secret storage backends.
 *
 * Manifests declare `capabilities.secrets: [GITHUB_TOKEN, APPROVER_GH_TOKEN, …]`.
 * This module owns the *storage* half: where a provisioned secret lives, how it
 * is retrieved at daemon-start / postinstall time, and how it is rotated and
 * removed. The install-time *flow* (prompt / --from-env / --skip-secrets) lives
 * in `secret-provision.ts`; the CLI verbs in `commands/secrets.ts`.
 *
 * Backends (issue §B):
 *   - KeychainBackend — macOS, wraps the `security` CLI. Service-scoped to the
 *     agent + secret name, account-scoped to the principal's username.
 *   - FileBackend — universal fallback. One secret per file under
 *     `<secretsRoot>/<agent>/<NAME>`, chmod 600 enforced on every write AND read
 *     (cortex#87 `enforceChmod600` pattern).
 *   - SystemdCredentialsBackend (Linux ≥256) is resolved at *daemon-start* by the
 *     unit's `LoadCredential` directive, not by arc at install time — arc stores
 *     to the FileBackend on Linux and the systemd unit's resolver reads it. A
 *     dedicated read-only backend is deferred (issue "Future considerations").
 *
 * NEVER-LOG invariant (issue §E): a secret VALUE must never be written to
 * stdout / stderr / argv-we-log / an audit line. Backends accept and return
 * values but never log them. `redactSecret()` is the only string a diagnostic
 * may print in a value's place. Service keys and file paths are built from the
 * agent + secret NAME only — never the value.
 */

import { mkdir, readFile, writeFile, chmod, stat, unlink, readdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { SecretDeclaration } from "../types.js";
import { errorMessage, isErrno } from "./errors.js";

/** Fixed sentinel printed in place of a secret value in any diagnostic. */
export const SECRET_REDACTION = "(secret redacted)";

/**
 * A declared secret folded to the shape the install path consumes (arc#363):
 * the NAME (always a string) plus whether a missing value may be tolerated.
 */
export interface DeclaredSecret {
  /** Env-var-shaped identifier — the storage key and the runtime env var. */
  name: string;
  /** `true` ⇒ a missing value must not fail install (see SecretDeclaration). */
  optional: boolean;
  /** Documented reason from the object form; "" for the bare-NAME shorthand. */
  reason: string;
}

/**
 * Fold a manifest's `capabilities.secrets` array to `{name, optional}` entries.
 * Accepts BOTH author shapes so `arc validate` and `arc install` never disagree
 * (arc#363 — validate used to accept the object form that install then crashed
 * on):
 *   - bare string NAME               → { name, optional: false }
 *   - { name, reason?, optional? }    → { name, optional: optional === true }
 *
 * A malformed entry (no string `name`) throws a clear, value-free error. In
 * practice `arc validate` / the strict validator reject that shape up front, so
 * install rarely reaches this throw — it is the last-line guard that keeps a
 * non-string name from ever reaching the storage backend.
 */
export function normalizeDeclaredSecrets(
  raw: readonly (string | SecretDeclaration)[] | undefined,
): DeclaredSecret[] {
  if (!raw) return [];
  return raw.map((entry): DeclaredSecret => {
    if (typeof entry === "string") return { name: entry, optional: false, reason: "" };
    // Runtime guard: a manifest read through the lenient loader (validate not
    // yet run) can smuggle a non-object/null here despite the static type — so
    // widen to `| null` and check `name` explicitly.
    const obj = entry as unknown as { name?: unknown; reason?: unknown; optional?: unknown } | null;
    if (obj && typeof obj.name === "string") {
      return {
        name: obj.name,
        optional: obj.optional === true,
        reason: typeof obj.reason === "string" ? obj.reason : "",
      };
    }
    throw new Error(
      `invalid secret declaration: expected a NAME string or a { name, reason?, optional? } object; got ${JSON.stringify(entry)}`,
    );
  });
}

/**
 * Return the redaction sentinel. Exists as a named function (rather than the
 * bare constant) so call sites read as an explicit, greppable redaction — and
 * so a value accidentally passed in is swallowed, never echoed.
 */
export function redactSecret(_value: string): string {
  return SECRET_REDACTION;
}

/**
 * Derive the platform-stable service key for a secret:
 *   `ai.meta-factory.cortex.<agent>.<SECRET_NAME>`
 *
 * Built from NAMES only (issue §B) — the value is never part of the key, so
 * the key is safe to log.
 */
export function secretServiceKey(agent: string, name: string): string {
  return `ai.meta-factory.cortex.${agent}.${name}`;
}

// A secret/agent name is an env-var-shaped identifier; reject anything that
// could escape the per-agent directory or smuggle a separator into a service
// key. This is the storage-layer guard; the CLI/provision layer validates the
// manifest declaration up front too.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSecretName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid secret name "${name}": expected an env-var-shaped identifier ([A-Za-z_][A-Za-z0-9_]*)`,
    );
  }
}

function assertAgentName(agent: string): void {
  // The agent scope is the manifest package name. Ecosystem packages may lead
  // with an underscore (e.g. `_JIRA`, `_CONFLUENCE`) and use hyphens
  // (`dev-loop`). Allow `[A-Za-z0-9_]` to start, then `[A-Za-z0-9_-]` — but
  // never a path separator or `..` (those would escape `<root>/<agent>/`).
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(agent)) {
    throw new Error(
      `invalid agent name "${agent}": expected a package-name slug ([A-Za-z0-9_][A-Za-z0-9_-]*)`,
    );
  }
}

/**
 * A single secret-storage backend. Names in / values in-and-out; the backend
 * never logs the value.
 */
export interface SecretBackend {
  /** Persist `value` under `name`. Overwrites unless the backend forbids it. */
  store(name: string, value: string): Promise<void>;
  /** Return the stored value, or `null` if not present. */
  retrieve(name: string): Promise<string | null>;
  /** Delete the secret. Idempotent — no throw if it was already absent. */
  remove(name: string): Promise<void>;
  /** Stored secret NAMES for this agent (never values). */
  list(): Promise<string[]>;
  /**
   * Replace the value with no in-place overwrite (issue §E): delete the old
   * entry, then add the new one. Default impl is remove-then-store; a backend
   * may override if its native primitive differs.
   */
  rotate(name: string, value: string): Promise<void>;
}

/** Result of a `security` CLI invocation. Mirrors the subset we consume. */
export interface SecurityResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the macOS `security` CLI. Injectable so tests never touch the real
 * login keychain. The default runner spawns `security` synchronously and
 * captures stdout/stderr (never logged by this module).
 */
export type SecurityRunner = (args: string[]) => SecurityResult;

const defaultSecurityRunner: SecurityRunner = (args) => {
  const result = Bun.spawnSync(["security", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

// `security` returns exit 44 (errSecItemNotFound) when an item is absent.
const SEC_ITEM_NOT_FOUND = 44;

/**
 * macOS Keychain backend. Each secret is a generic password keyed by
 * `secretServiceKey(agent, name)` and scoped to the principal's username.
 *
 * ARGV EXPOSURE (security finding, arc#234 review): `security
 * add-generic-password -w <value>` places the secret VALUE on the spawned
 * process's argv. For the lifetime of the spawn it is readable by any process
 * that can see this user's process table — via `ps auxww` or
 * `/proc/<pid>/cmdline` — which on a SHARED multi-user macOS host (or a
 * shared-PID-namespace container) is another user. This is a limitation of the
 * macOS `security` CLI: its `-w` flag has no stdin channel, so a value passed
 * non-interactively MUST go through argv. (Contrast: `gh auth login` reads its
 * token from STDIN via `--with-token` — `security -w` has no equivalent. The
 * earlier comment here claimed parity with gh; that was factually wrong.)
 *
 * Mitigation lives in {@link resolveSecretBackend}, NOT here: on a host that
 * indicates a shared / CI context, arc selects the chmod-600 FileBackend
 * instead, so the argv window is opt-in on single-user dev machines only.
 * Residual risk on a dev machine: the value is on argv for the few-millisecond
 * `spawnSync` duration; acceptable for a single-user box, mitigated everywhere
 * else.
 *
 * This class never *logs* argv (issue §E) — that obligation is upheld
 * regardless of the argv exposure above.
 */
export class KeychainBackend implements SecretBackend {
  constructor(
    private readonly agent: string,
    private readonly account: string,
    private readonly runner: SecurityRunner = defaultSecurityRunner,
  ) {
    assertAgentName(agent);
  }

  async store(name: string, value: string): Promise<void> {
    assertSecretName(name);
    const service = secretServiceKey(this.agent, name);
    // -U updates in place if present; for rotate we delete-then-add explicitly.
    const r = this.runner([
      "add-generic-password",
      "-s", service,
      "-a", this.account,
      "-U",
      "-w", value,
    ]);
    if (r.exitCode !== 0) {
      // No `cause`: this is a synthesized error from a CLI exit code, not a
      // caught exception — there is no upstream Error to chain.
      throw new Error(
        `keychain store failed for ${service} (exit ${r.exitCode}): ${r.stderr.trim()}`,
      );
    }
    // Async to satisfy the interface; the spawn is synchronous.
    return Promise.resolve();
  }

  retrieve(name: string): Promise<string | null> {
    assertSecretName(name);
    const service = secretServiceKey(this.agent, name);
    const r = this.runner([
      "find-generic-password",
      "-s", service,
      "-a", this.account,
      "-w",
    ]);
    if (r.exitCode === SEC_ITEM_NOT_FOUND) return Promise.resolve(null);
    if (r.exitCode !== 0) {
      // Loud, not silent (issue §E): retrieval failure other than not-found is
      // an error the operator must see — but NEVER includes the value.
      throw new Error(
        `keychain retrieve failed for ${service} (exit ${r.exitCode}): ${r.stderr.trim()}. ` +
          `Re-run \`arc secrets set <agent> ${name}\` to repair.`,
      );
    }
    // `security -w` prints the raw value plus exactly ONE trailing newline it
    // adds itself. Strip only that single appended "\n" — a regex like
    // /\n$/ collapses to the same single strip, but `slice` makes the intent
    // explicit and provably touches at most one char, so a value that
    // legitimately ends in "\n" round-trips as `value + "\n"` → stored, then
    // retrieved as `value + "\n\n"` from `security` → sliced back to
    // `value + "\n"`. (FileBackend has no such transform; values round-trip
    // byte-for-byte there.)
    const out = r.stdout;
    return Promise.resolve(out.endsWith("\n") ? out.slice(0, -1) : out);
  }

  remove(name: string): Promise<void> {
    assertSecretName(name);
    const service = secretServiceKey(this.agent, name);
    const r = this.runner([
      "delete-generic-password",
      "-s", service,
      "-a", this.account,
    ]);
    if (r.exitCode !== 0 && r.exitCode !== SEC_ITEM_NOT_FOUND) {
      throw new Error(
        `keychain remove failed for ${service} (exit ${r.exitCode}): ${r.stderr.trim()}`,
      );
    }
    return Promise.resolve();
  }

  async rotate(name: string, value: string): Promise<void> {
    // No in-place overwrite (issue §E): delete the old item, then add the new.
    await this.remove(name);
    await this.store(name, value);
  }

  list(): Promise<string[]> {
    // `security` has no clean "enumerate items for a service prefix" without
    // dumping the whole login keychain (and parsing an unstable text format).
    // Rather than silently return [] — which would make `arc secrets list`
    // lie "no secrets" on macOS even when secrets exist (arc#234 review nit 2)
    // — we signal unsupported. The command layer catches this and tells the
    // operator to use `arc secrets check <agent>` instead, which resolves
    // presence per manifest-declared name via retrieve() and works on every
    // backend.
    return Promise.reject(new SecretListUnsupportedError("keychain"));
  }
}

/**
 * Thrown by a backend whose storage primitive cannot enumerate stored secret
 * names (e.g. the macOS Keychain). The command layer catches it and points the
 * operator at `arc secrets check <agent>` (manifest-driven, backend-agnostic).
 */
export class SecretListUnsupportedError extends Error {
  constructor(public readonly backend: string) {
    super(
      `Listing stored secrets is not supported on the ${backend} backend. ` +
        `Use \`arc secrets check <agent>\` to see which declared secrets are present.`,
    );
    this.name = "SecretListUnsupportedError";
  }
}

/**
 * Universal file backend. One secret per file at
 * `<secretsRoot>/<agent>/<NAME>`, chmod 600 enforced on every write and read.
 */
export class FileBackend implements SecretBackend {
  private readonly agentDir: string;

  constructor(
    private readonly secretsRoot: string,
    private readonly agent: string,
  ) {
    assertAgentName(agent);
    this.agentDir = join(secretsRoot, agent);
  }

  private pathFor(name: string): string {
    assertSecretName(name);
    return join(this.agentDir, name);
  }

  async store(name: string, value: string): Promise<void> {
    const path = this.pathFor(name);
    await mkdir(this.agentDir, { recursive: true });
    // Atomic write (arc#234 review nit 1): write the new value into a fresh
    // 0600 temp file in the SAME directory, then rename it over the target.
    // `rename(2)` within one filesystem is atomic, so a concurrent reader sees
    // either the old complete file or the new one — never a truncated value,
    // and never the old content sitting at a transiently-loose mode (the
    // earlier `writeFile`-then-`chmod` left that TOCTOU window on overwrite).
    // The temp name is unguessable so two concurrent stores don't collide.
    const tmpPath = join(this.agentDir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmpPath, value, { mode: 0o600 });
      // writeFile's `mode` is honored only on create + subject to umask; force
      // 0600 explicitly before the value is visible at the final path.
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, path);
    } catch (err) {
      // Best-effort cleanup of the temp file so a failed store never leaves a
      // secret-bearing orphan behind. Swallow ENOENT (rename already consumed
      // it); never log the value.
      await unlink(tmpPath).catch(() => {
        /* temp file already gone or never created — nothing to clean up */
      });
      throw new Error(`failed to store secret file: ${errorMessage(err)}`, { cause: err });
    }
  }

  async retrieve(name: string): Promise<string | null> {
    const path = this.pathFor(name);
    if (!existsSync(path)) return null;
    // cortex#87 pattern: re-enforce 600 on read — a file that drifted to a
    // looser mode is tightened, loudly-correctable rather than silently used.
    await enforceChmod600(path);
    return readFile(path, "utf-8");
  }

  async remove(name: string): Promise<void> {
    const path = this.pathFor(name);
    try {
      await unlink(path);
    } catch (err) {
      // Idempotent: already-gone is success. Surface any other errno.
      if (isErrno(err) && err.code === "ENOENT") return;
      throw new Error(`failed to remove secret file: ${errorMessage(err)}`, { cause: err });
    }
  }

  async rotate(name: string, value: string): Promise<void> {
    await this.remove(name);
    await this.store(name, value);
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.agentDir)) return [];
    const entries = await readdir(this.agentDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && NAME_RE.test(e.name))
      .map((e) => e.name);
  }
}

/**
 * Re-enforce chmod 600 on a secret file (cortex#87). Called on every read so a
 * file that drifted to a too-open mode is tightened before its contents are
 * handed out. Throws (loud, never silent) on a chmod failure other than a
 * missing file.
 */
export async function enforceChmod600(path: string): Promise<void> {
  try {
    const mode = (await stat(path)).mode & 0o777;
    if (mode !== 0o600) {
      await chmod(path, 0o600);
    }
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return;
    throw new Error(`failed to enforce chmod 600 on secret file: ${errorMessage(err)}`, { cause: err });
  }
}

/** Explicit backend selection override (`--secret-backend`). */
export type SecretBackendChoice = "auto" | "keychain" | "file";

/** Options for {@link resolveSecretBackend}. */
export interface ResolveBackendOpts {
  /** `process.platform` (or an override for tests). */
  platform: string;
  /** Root directory for the FileBackend fallback. */
  secretsRoot: string;
  /** Principal's username — the Keychain account scope. */
  username: string;
  /** Injected `security` runner (tests / non-darwin). */
  securityRunner?: SecurityRunner;
  /**
   * Whether the native keychain is usable. Defaults to probing `security`
   * existence on darwin. Pass explicitly in tests to avoid touching the host.
   */
  keychainAvailable?: boolean;
  /**
   * Explicit operator choice (`--secret-backend`): `keychain` forces the
   * Keychain even on a shared/CI host (accepting the argv exposure), `file`
   * forces the chmod-600 file backend, `auto` (default) applies the
   * shared-host heuristic below.
   */
  backendChoice?: SecretBackendChoice;
  /**
   * Whether the host is a shared / CI context where the Keychain argv-exposure
   * window (see {@link KeychainBackend}) is unacceptable. Defaults to the
   * {@link isSharedOrCiHost} env heuristic. When true under `auto`, arc selects
   * the FileBackend even on darwin.
   */
  sharedHost?: boolean;
  /** Env source for the shared-host heuristic (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

/**
 * Select the storage backend for an agent.
 *
 * Default (`auto`): native Keychain on macOS — UNLESS the host looks shared /
 * CI, in which case the chmod-600 FileBackend is preferred so the macOS
 * `security` argv-exposure window (see {@link KeychainBackend}) is opt-in on
 * single-user dev machines only (arc#234 review MAJOR). `--secret-backend
 * keychain|file` overrides the heuristic.
 *
 * Linux/Windows always use the FileBackend at install time; on Linux the
 * systemd unit's `LoadCredential` resolves the file at daemon-start. There is
 * no install-time SystemdCredentialsBackend (the credential is read by systemd,
 * not arc).
 */
export function resolveSecretBackend(
  agent: string,
  opts: ResolveBackendOpts,
): SecretBackend {
  const choice = opts.backendChoice ?? "auto";

  if (choice === "file") {
    return new FileBackend(opts.secretsRoot, agent);
  }

  const fileBackend = () => new FileBackend(opts.secretsRoot, agent);
  const keychainBackend = () =>
    new KeychainBackend(agent, opts.username, opts.securityRunner);

  if (choice === "keychain") {
    // Operator explicitly opted in — honor it even on a shared host, but only
    // where the Keychain actually exists.
    if (opts.platform === "darwin") {
      const available = opts.keychainAvailable ?? isSecurityCliAvailable();
      if (available) return keychainBackend();
    }
    // Asked for keychain on a non-darwin host — fall back rather than fail.
    return fileBackend();
  }

  // auto
  if (opts.platform === "darwin") {
    const shared = opts.sharedHost ?? isSharedOrCiHost(opts.env);
    if (shared) {
      // Prefer the file backend on a shared/CI macOS host: the argv exposure
      // is the at-risk case there.
      return fileBackend();
    }
    const available = opts.keychainAvailable ?? isSecurityCliAvailable();
    if (available) return keychainBackend();
  }
  return fileBackend();
}

/**
 * Heuristic for "this is a shared / CI host where another user could read the
 * process table". Conservative: any common CI marker, or an explicit
 * `ARC_SHARED_HOST=1`, flips it on. False on a typical single-user dev box.
 */
export function isSharedOrCiHost(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (truthyEnv(env.ARC_SHARED_HOST)) return true;
  // Common CI providers set `CI`; GitHub Actions also sets `GITHUB_ACTIONS`.
  if (truthyEnv(env.CI)) return true;
  if (truthyEnv(env.GITHUB_ACTIONS)) return true;
  if (truthyEnv(env.CONTINUOUS_INTEGRATION)) return true;
  return false;
}

function truthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no";
}

/** Probe whether the macOS `security` CLI is on PATH. */
export function isSecurityCliAvailable(): boolean {
  const r = Bun.spawnSync(["security", "help"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 || r.exitCode === 1; // `security help` exits 1 but exists
}
