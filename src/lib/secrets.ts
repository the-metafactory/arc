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

import { mkdir, readFile, writeFile, chmod, stat, unlink, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { errorMessage, isErrno } from "./errors.js";

/** Fixed sentinel printed in place of a secret value in any diagnostic. */
export const SECRET_REDACTION = "(secret redacted)";

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
 * The VALUE is passed to `security` via `-w <value>` through the injected
 * runner only; this class never logs argv (issue §E). Note: `security`'s own
 * `-w` does place the value on the spawned process's argv — that is the OS
 * keychain tool's contract and is the same path `gh auth login` uses. arc's
 * obligation is to never *log* it, which it does not.
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
    // `-w` prints the raw value plus a trailing newline.
    return Promise.resolve(r.stdout.replace(/\n$/, ""));
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
    // `security` has no clean "list items for a service prefix" without
    // dumping the whole keychain. The authoritative roster of an agent's
    // secrets is the manifest's `capabilities.secrets`; `list`/`check` resolve
    // presence per declared name via retrieve(). So the backend-level list is
    // intentionally empty here, and SecretResolver-level enumeration is driven
    // by the manifest (see secret-provision.ts validateSecretPresence).
    return Promise.resolve([]);
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
    // Write with mode 600 from the start, then re-chmod in case the file
    // pre-existed with looser perms (write-with-mode only applies on create).
    await writeFile(path, value, { mode: 0o600 });
    await chmod(path, 0o600);
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
}

/**
 * Select the storage backend for an agent: native (Keychain on macOS) when
 * available, else the universal chmod-600 FileBackend.
 *
 * Linux uses the FileBackend at install time; the systemd unit's
 * `LoadCredential` resolves the file at daemon-start. There is no install-time
 * SystemdCredentialsBackend (the credential is read by systemd, not arc).
 */
export function resolveSecretBackend(
  agent: string,
  opts: ResolveBackendOpts,
): SecretBackend {
  if (opts.platform === "darwin") {
    const available =
      opts.keychainAvailable ?? isSecurityCliAvailable();
    if (available) {
      return new KeychainBackend(agent, opts.username, opts.securityRunner);
    }
  }
  return new FileBackend(opts.secretsRoot, agent);
}

/** Probe whether the macOS `security` CLI is on PATH. */
export function isSecurityCliAvailable(): boolean {
  const r = Bun.spawnSync(["security", "help"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 || r.exitCode === 1; // `security help` exits 1 but exists
}
