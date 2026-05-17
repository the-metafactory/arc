/**
 * arc nats — NATS bot identity management.
 *
 * Wraps NSC to provision per-bot NATS users under an operator's account.
 * Part of grove#320 (bot-level AAA) — operator-level infrastructure tooling.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { generateIdentity } from "./identity.js";
import {
  ArcNatsCommandError,
  type ArcNatsErrorCode,
  type SetupOperatorBotResult,
  classifyError,
} from "../lib/json-response.js";

const DEFAULT_CREDS_DIR = join(homedir(), ".config", "nats");
const NAMING_RE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;
const NATS_SUBJECT_RE = /^[a-zA-Z0-9.*>_-]+$/;

// NSC config can live in several locations depending on version/platform
const NSC_CONFIG_CANDIDATES = [
  join(homedir(), ".config", "nats", "nsc", "nsc.json"),
  join(homedir(), ".nsc", "nsc.json"),
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nsc", "nsc.json"),
];

/**
 * Result of an nsc invocation. Shape matches the subset of Bun.spawnSync
 * we care about; broken out as an interface so tests can stub the runner
 * without depending on Bun internals.
 */
export interface NscResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type NscRunner = (args: string[]) => NscResult;

const defaultRunner: NscRunner = (args) => {
  const result = Bun.spawnSync(["nsc", ...args], { stderr: "pipe", stdout: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

let runner: NscRunner = defaultRunner;

/**
 * Test-only hook to swap the nsc runner. Pass `null` to restore the default.
 *
 * Gated on test-mode env so production callers that import this module can't
 * silently swap the runner process-wide. Set `ARC_TEST_MODE=1` (or
 * `NODE_ENV=test`, which `bun:test` sets implicitly) to enable the swap.
 */
export function __setNscRunnerForTests(next: NscRunner | null): void {
  assertTestModeForSeam("__setNscRunnerForTests");
  runner = next ?? defaultRunner;
}

function nsc(args: string[]): string {
  const result = runner(args);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.exitCode !== 0) {
    throw new Error(`nsc ${args[0]} failed: ${stderr || stdout || "unknown error"}`);
  }
  return stdout;
}

function nscWithStderr(args: string[]): string {
  const result = runner(args);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new Error(`nsc ${args[0]} failed: ${stderr || stdout || "unknown error"}`);
  }
  return (result.stdout + result.stderr).trim();
}

let nscInstallCheck: () => boolean = () => {
  return Bun.spawnSync(["which", "nsc"], { stdout: "pipe" }).exitCode === 0;
};

/**
 * Test-only hook to swap the install check. Pass `null` to restore the default.
 * Gated on test-mode env; see {@link __setNscRunnerForTests}.
 */
export function __setNscInstallCheckForTests(next: (() => boolean) | null): void {
  assertTestModeForSeam("__setNscInstallCheckForTests");
  nscInstallCheck = next ?? (() => Bun.spawnSync(["which", "nsc"], { stdout: "pipe" }).exitCode === 0);
}

function assertTestModeForSeam(seamName: string): void {
  if (process.env.ARC_TEST_MODE !== "1" && process.env.NODE_ENV !== "test") {
    throw new Error(
      `${seamName} is a test-only seam. Set ARC_TEST_MODE=1 or NODE_ENV=test to enable.`,
    );
  }
}

export function ensureNscInstalled(json = false): void {
  if (!nscInstallCheck()) {
    if (json) {
      throw new ArcNatsCommandError(
        "NSC_NOT_INSTALLED",
        "nsc not found on PATH. Install: brew install nats-io/nats-tools/nsc",
      );
    }
    console.error("Error: nsc not found on PATH.");
    console.error("Install: brew install nats-io/nats-tools/nsc");
    process.exit(1);
  }
}

function validateBotName(name: string, json = false): void {
  if (!NAMING_RE.test(name)) {
    if (json) {
      throw new ArcNatsCommandError(
        "VALIDATION_ERROR",
        `bot name "${name}" must be lowercase alphanumeric + hyphens.`,
      );
    }
    console.error(`Error: bot name "${name}" must be lowercase alphanumeric + hyphens.`);
    process.exit(1);
  }
}

function validateSubject(subject: string): void {
  if (!NATS_SUBJECT_RE.test(subject)) {
    // arc#136: must be ArcNatsCommandError("VALIDATION_ERROR") so --json mode
    // reports the right code. A plain Error falls into the catch-all that
    // rewrites it as ROLLBACK_FAILED, which is misleading for a pre-create
    // input-validation failure.
    throw new ArcNatsCommandError(
      "VALIDATION_ERROR",
      `Invalid NATS subject: "${subject}" — only alphanumeric, dots, wildcards, hyphens, underscores allowed`,
    );
  }
}

export function detectAccount(): string {
  for (const candidate of NSC_CONFIG_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const config = JSON.parse(readFileSync(candidate, "utf-8")) as { account?: unknown };
      if (typeof config.account === "string") {
        return config.account;
      }
    } catch {
      continue;
    }
  }
  // Fallback: parse nsc env output (env writes to stderr)
  const output = nscWithStderr(["env"]);
  const match = /Current Account\s+\|[^|]*\|\s+(\S+)/.exec(output);
  if (match) return match[1];
  throw new ArcNatsCommandError(
    "ACCOUNT_NOT_FOUND",
    "Cannot detect NSC account. Run: nsc env -a <account>",
  );
}

function defaultCredsPath(name: string): string {
  return join(DEFAULT_CREDS_DIR, `${name}.creds`);
}

/**
 * Extracts the JWT body from an `nsc generate creds` output. The output is a
 * two-block PEM-ish file with `-----BEGIN NATS USER JWT-----` ... `-----END NATS USER JWT-----`
 * followed by an `-----BEGIN USER NKEY SEED-----` block. We return the JWT
 * body (between the BEGIN/END markers, whitespace-stripped).
 *
 * Returns empty string if the JWT block is not present — caller should treat
 * that as a soft failure (the creds file is still written, but the JSON
 * envelope's `jwt` field will be empty).
 */
function extractJwt(credsContent: string): string {
  const match = /-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*-----END NATS USER JWT-----/.exec(credsContent);
  if (!match) return "";
  return match[1].replace(/\s+/g, "");
}

function userExists(account: string, name: string): boolean {
  try {
    nsc(["describe", "user", "-a", account, "-n", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the user's NKey public key (the `sub` claim in the user JWT).
 * Must be called BEFORE deleting the user — once the user record is gone,
 * nsc can no longer resolve the pubkey.
 */
function getUserPubKey(account: string, name: string): string {
  const json = nsc(["describe", "user", "-a", account, "-n", name, "-J"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ArcNatsCommandError(
      "INVALID_USER_KEY",
      `Failed to parse nsc describe user JSON for "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const sub = (parsed as { sub?: unknown }).sub;
  if (typeof sub !== "string" || !sub.startsWith("U")) {
    throw new ArcNatsCommandError(
      "INVALID_USER_KEY",
      `Could not extract user public key for "${name}" (expected U-prefixed NKey in 'sub' claim).`,
    );
  }
  return sub;
}

/**
 * Server-side revoke: add the user's pubkey to the account's revocation map
 * and push the updated account JWT to NATS so the server rejects any
 * outstanding `.creds` for that user.
 *
 * Aborts (throws) on push failure — the caller MUST NOT proceed to delete
 * the user locally if this throws, because a half-done revoke leaves the
 * JWT valid on the bus and the operator unaware.
 */
function revokeAndPushUser(account: string, name: string): string {
  const pubKey = getUserPubKey(account, name);

  // Add to revocation map (keyed by pubkey so it survives local user delete).
  try {
    nsc(["revocations", "add-user", "-a", account, "-u", pubKey]);
  } catch (err) {
    throw new ArcNatsCommandError(
      "REVOKE_FAILED",
      `Failed to add revocation for user "${name}" (${pubKey}): ${err instanceof Error ? err.message : String(err)}. ` +
      `The user JWT is STILL VALID on the bus.`,
    );
  }

  // Push the updated account JWT so the NATS server picks up the revocation.
  // If this fails, the JWT remains valid server-side — abort loudly.
  try {
    nsc(["push", "-a", account]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ArcNatsCommandError(
      "PUSH_FAILED",
      `Server-side revoke failed: ${reason}. The user JWT is STILL VALID on the bus. ` +
      `Resolve connectivity and retry.`,
    );
  }

  return pubKey;
}

function ensureDefaultCredsDir(): void {
  if (!existsSync(DEFAULT_CREDS_DIR)) {
    mkdirSync(DEFAULT_CREDS_DIR, { recursive: true, mode: 0o700 });
  }
  chmodSync(DEFAULT_CREDS_DIR, 0o700);
}

function writeCredsFile(path: string, content: string): void {
  // Only enforce directory permissions on the default creds dir
  if (dirname(path) === DEFAULT_CREDS_DIR) {
    ensureDefaultCredsDir();
  }
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface AddBotOptions {
  account?: string;
  pub?: string;
  sub?: string;
  output?: string;
  force?: boolean;
  withIdentity?: boolean;
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface AddBotResult {
  bot: string;
  account: string;
  credsPath: string;
  jwt: string;
  pubKey: string;
}

export async function addBot(name: string, opts: AddBotOptions): Promise<AddBotResult> {
  const json = opts.json === true;
  ensureNscInstalled(json);

  validateBotName(name, json);

  const account = opts.account ?? detectAccount();
  const outPath = opts.output ?? defaultCredsPath(name);

  if (existsSync(outPath) && !opts.force) {
    if (json) {
      throw new ArcNatsCommandError(
        "ALREADY_EXISTS",
        `credentials exist at ${outPath}. Use --force to overwrite.`,
      );
    }
    console.error(`Error: credentials exist at ${outPath}. Use --force to overwrite.`);
    process.exit(1);
  }

  if (userExists(account, name)) {
    if (!opts.force) {
      if (json) {
        throw new ArcNatsCommandError(
          "ALREADY_EXISTS",
          `user "${name}" exists under "${account}". Use --force to re-create.`,
        );
      }
      console.error(`Error: user "${name}" exists under "${account}". Use --force to re-create.`);
      process.exit(1);
    }
    nsc(["delete", "user", "-a", account, "-n", name]);
    if (!json) console.log(`Removed existing user: ${name}`);
  }

  nsc(["add", "user", "-a", account, "-n", name]);

  let credsContent: string;
  try {
    if (opts.pub) {
      for (const subj of opts.pub.split(",").map((s) => s.trim())) {
        validateSubject(subj);
        nsc(["edit", "user", "-a", account, "-n", name, "--allow-pub", subj]);
      }
    }

    if (opts.sub) {
      for (const subj of opts.sub.split(",").map((s) => s.trim())) {
        validateSubject(subj);
        nsc(["edit", "user", "-a", account, "-n", name, "--allow-sub", subj]);
      }
    }

    credsContent = nsc(["generate", "creds", "-a", account, "-n", name]);
    writeCredsFile(outPath, credsContent);
  } catch (err) {
    try { nsc(["delete", "user", "-a", account, "-n", name]); } catch { /* best effort */ }
    const cause = err instanceof ArcNatsCommandError ? err.message : (err instanceof Error ? err.message : String(err));
    const code: ArcNatsErrorCode = err instanceof ArcNatsCommandError ? err.code : "ROLLBACK_FAILED";
    if (json) {
      throw new ArcNatsCommandError(code, `Failed to configure user "${name}" — rolled back. Cause: ${cause}`);
    }
    throw new Error(
      `Failed to configure user "${name}" — rolled back. Cause: ${cause}`,
      { cause: err },
    );
  }

  // Surface the durable pubkey (matches what cortex receives in JSON mode and
  // what the revoke flow will key on later).
  const pubKey = getUserPubKey(account, name);
  const jwt = extractJwt(credsContent);

  if (!json) {
    console.log(`Created NATS user: ${name} (account: ${account})`);
    if (opts.pub) console.log(`  publish: ${opts.pub}`);
    if (opts.sub) console.log(`  subscribe: ${opts.sub}`);
    console.log(`  credentials: ${outPath} (mode 600)`);
  }

  if (opts.withIdentity) {
    // generateIdentity prints; in json mode we want it silenced. Cheapest path
    // is to suppress console.log for the duration of the call. (No tests rely
    // on this output being visible during json runs.)
    if (json) {
      const origLog = console.log;
      console.log = () => undefined;
      try {
        await generateIdentity(name, account, { force: opts.force });
      } finally {
        console.log = origLog;
      }
    } else {
      await generateIdentity(name, account, { force: opts.force });
    }
  }

  return { bot: name, account, credsPath: outPath, jwt, pubKey };
}

export interface ReissueBotOptions {
  account?: string;
  output?: string;
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface ReissueBotResult {
  bot: string;
  account: string;
  credsPath: string;
  newPubKey: string;
  revokedPubKey: string;
}

export function reissueBot(name: string, opts: ReissueBotOptions): ReissueBotResult {
  const json = opts.json === true;
  ensureNscInstalled(json);
  validateBotName(name, json);
  const account = opts.account ?? detectAccount();
  const outPath = opts.output ?? defaultCredsPath(name);

  if (!userExists(account, name)) {
    if (json) {
      throw new ArcNatsCommandError(
        "USER_NOT_FOUND",
        `user "${name}" not found under "${account}".`,
      );
    }
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  // Revoke the OLD user pubkey server-side BEFORE we touch local state. If
  // this fails we abort cleanly: no local delete, and — critically — no .bak
  // on disk holding the still-valid old creds (writing the backup before the
  // revoke would re-create the exact leaked-backup threat #130 was filed for).
  let revokedPubKey = "";
  try {
    revokedPubKey = revokeAndPushUser(account, name);
  } catch (err) {
    if (json) {
      // Re-throw as-is — revokeAndPushUser already throws ArcNatsCommandError
      // with the right code (REVOKE_FAILED / PUSH_FAILED).
      if (err instanceof ArcNatsCommandError) throw err;
      throw new ArcNatsCommandError("PUSH_FAILED", err instanceof Error ? err.message : String(err));
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // nsc requires delete+add for new keys (no in-place rekey). Now that the
  // old JWT is revoked server-side, the .bak is safe to write — its
  // embedded creds are already dead on the bus.
  if (existsSync(outPath)) {
    const backup = `${outPath}.bak`;
    writeFileSync(backup, readFileSync(outPath));
    chmodSync(backup, 0o600);
    if (!json) console.log(`  backup: ${backup}`);
  }

  nsc(["delete", "user", "-a", account, "-n", name]);

  try {
    nsc(["add", "user", "-a", account, "-n", name]);
    const creds = nsc(["generate", "creds", "-a", account, "-n", name]);
    writeCredsFile(outPath, creds);
  } catch (err) {
    if (json) {
      throw new ArcNatsCommandError(
        "ROLLBACK_FAILED",
        `CRITICAL: failed to re-create user "${name}" after delete. ` +
        `Old creds revoked server-side; backup at ${outPath}.bak captures the old JWT for forensics only. ` +
        `Manual recovery: nsc add user -a ${account} -n ${name}. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.error(`CRITICAL: failed to re-create user "${name}" after delete.`);
    if (existsSync(`${outPath}.bak`)) {
      console.error(`Old credentials backed up at: ${outPath}.bak`);
      console.error(
        `Note: old creds invalidated via revocations push above; the backup ` +
        `captures the old JWT for forensics only (it's revoked server-side ` +
        `and will be rejected by NATS).`,
      );
    }
    console.error(`Manual recovery: nsc add user -a ${account} -n ${name}`);
    console.error(`Cause: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Clean up backup on success
  try { unlinkSync(`${outPath}.bak`); } catch { /* ok if no backup */ }

  const newPubKey = getUserPubKey(account, name);

  if (!json) {
    console.log(`Re-issued credentials for ${name}`);
    console.log(`  credentials: ${outPath} (mode 600)`);
    console.log(`  Note: old credentials revoked server-side and pushed to NATS.`);
  }

  return { bot: name, account, credsPath: outPath, newPubKey, revokedPubKey };
}

export function listBots(account?: string): void {
  ensureNscInstalled();
  const acct = account ?? detectAccount();
  console.log(nsc(["list", "users", "-a", acct]));
}

export interface RemoveBotOptions {
  account?: string;
  deleteCreds?: boolean;
  output?: string;
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface RemoveBotResult {
  bot: string;
  account: string;
  revokedPubKey: string;
  credsFileDeleted: boolean;
}

export interface SetupOperatorOptions {
  force?: boolean;
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface SetupOperatorResult {
  account: string;
  bots: SetupOperatorBotResult[];
  summary: { total: number; ok: number; failed: number };
}

export async function setupOperator(
  account: string,
  botNames: string[],
  opts: SetupOperatorOptions,
): Promise<SetupOperatorResult> {
  const json = opts.json === true;
  ensureNscInstalled(json);

  if (!json) console.log(`Setting up ${botNames.length} bot(s) for operator ${account}...\n`);

  const bots: SetupOperatorBotResult[] = [];

  for (const name of botNames) {
    if (!json) console.log(`── ${name} ──`);
    try {
      // Note: per-bot addBot inherits the parent json flag so its output is
      // suppressed in JSON mode (cortex consumes only the final envelope).
      const result = await addBot(name, {
        account,
        withIdentity: true,
        force: opts.force,
        json,
      });
      if (!json) console.log();
      bots.push({
        bot: name,
        ok: true,
        credsPath: result.credsPath,
        pubKey: result.pubKey,
      });
    } catch (err) {
      const classified = classifyError(err);
      if (!json) console.error(`  FAILED: ${classified.message}\n`);
      bots.push({
        bot: name,
        ok: false,
        error: classified,
      });
    }
  }

  const okCount = bots.filter((b) => b.ok).length;
  const failedCount = bots.length - okCount;

  if (!json) {
    console.log(`\n── Summary ──`);
    console.log(`  ${okCount}/${botNames.length} bots provisioned`);
    if (failedCount > 0) {
      console.log(`  Failed: ${bots.filter((b) => !b.ok).map((b) => b.bot).join(", ")}`);
    }
    console.log(`\nNext steps:`);
    console.log(`  1. arc identity export > ${account.toLowerCase()}-principals.json`);
    console.log(`  2. Send the file to other operators`);
    console.log(`  3. arc identity import <other-operator>-principals.json`);
  }

  return {
    account,
    bots,
    summary: { total: botNames.length, ok: okCount, failed: failedCount },
  };
}

export function removeBot(name: string, opts: RemoveBotOptions): RemoveBotResult {
  const json = opts.json === true;
  ensureNscInstalled(json);
  validateBotName(name, json);
  const account = opts.account ?? detectAccount();

  if (!userExists(account, name)) {
    if (json) {
      throw new ArcNatsCommandError(
        "USER_NOT_FOUND",
        `user "${name}" not found under "${account}".`,
      );
    }
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  // Server-side revoke FIRST: add user pubkey to the account's revocation
  // map and push the updated account JWT. If this fails we abort BEFORE
  // deleting locally — a half-done revoke leaves a still-valid JWT on the
  // bus and the operator unaware.
  let revokedPubKey = "";
  try {
    revokedPubKey = revokeAndPushUser(account, name);
  } catch (err) {
    if (json) {
      if (err instanceof ArcNatsCommandError) throw err;
      throw new ArcNatsCommandError("PUSH_FAILED", err instanceof Error ? err.message : String(err));
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  nsc(["delete", "user", "-a", account, "-n", name]);
  if (!json) console.log(`Revoked and removed user: ${name} (account: ${account})`);

  let credsFileDeleted = false;
  if (opts.deleteCreds) {
    const path = opts.output ?? defaultCredsPath(name);
    if (existsSync(path)) {
      unlinkSync(path);
      credsFileDeleted = true;
      if (!json) console.log(`Deleted credentials: ${path}`);
    } else {
      if (!json) console.log(`Warning: no credentials file at ${path} (custom -o path used at creation?)`);
    }
  }

  return { bot: name, account, revokedPubKey, credsFileDeleted };
}
