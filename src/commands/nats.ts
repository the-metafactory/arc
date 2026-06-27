/**
 * arc nats — NATS bot identity management + federation account topology.
 *
 * Wraps NSC to provision per-bot NATS users under an operator's account
 * (bot-level AAA) and to wire cross-account subject export/import for
 * federated.> routing across account boundaries (G1b — cortex#1117).
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
// NSC account names are UPPER_SNAKE by convention. Guard rejects empty strings
// and flag-injection values (e.g. "--all", "--force") that nsc would silently
// accept as option names, potentially touching the entire operator store.
const ACCOUNT_NAME_RE = /^[A-Z][A-Z0-9_]+$/;

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
    // arc#169: throw a typed error so consumers of --json get the precise
    // NSC_COMMAND_FAILED code instead of UNKNOWN (outside try blocks) or
    // having the addBot catch-all reclassify as ROLLBACK_FAILED.
    throw new ArcNatsCommandError(
      "NSC_COMMAND_FAILED",
      `nsc ${args[0]} failed: ${stderr || stdout || "unknown error"}`,
    );
  }
  return stdout;
}

function nscWithStderr(args: string[]): string {
  const result = runner(args);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new ArcNatsCommandError(
      "NSC_COMMAND_FAILED",
      `nsc ${args[0]} failed: ${stderr || stdout || "unknown error"}`,
    );
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

/**
 * Test-only direct accessors for the two private nsc wrappers.
 * Tests use these to assert that both wrappers throw the typed error on
 * non-zero exit without having to route through addBot's call graph.
 */
export function __nscForTests(args: string[]): string {
  assertTestModeForSeam("__nscForTests");
  return nsc(args);
}

export function __nscWithStderrForTests(args: string[]): string {
  assertTestModeForSeam("__nscWithStderrForTests");
  return nscWithStderr(args);
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

/**
 * Validates an NSC account name before passing it to any nsc invocation.
 *
 * NSC account names are UPPER_SNAKE by convention (e.g. "OP_HUB", "MYFACTORY").
 * Rejecting empty strings and flag-injection patterns (e.g. "--all", "--force")
 * prevents nsc push -a "" from pushing the entire operator store, and prevents
 * option-flag injection into nsc add export / add import / push -a calls.
 *
 * If arc ever needs to support lowercase or hyphenated account names, update
 * ACCOUNT_NAME_RE to match — but the empty + flag-injection guard MUST stay.
 */
function validateAccountName(name: string): void {
  if (!name || !ACCOUNT_NAME_RE.test(name)) {
    throw new ArcNatsCommandError(
      "VALIDATION_ERROR",
      `Invalid account name: "${name}" — must match [A-Z][A-Z0-9_]+ (UPPER_SNAKE). ` +
      `Empty or flag-style values (e.g. "--all") are not accepted.`,
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

  // arc#136 fail-fast: validate every subject before any nsc state changes,
  // so a bad --pub/--sub doesn't trigger a real `nsc add user` + rollback
  // round-trip for what is purely an input-validation failure. Split here
  // (rather than re-splitting inside the try below) so the same list is used
  // twice without divergence.
  const pubSubjects = opts.pub ? opts.pub.split(",").map((s) => s.trim()) : [];
  const subSubjects = opts.sub ? opts.sub.split(",").map((s) => s.trim()) : [];
  for (const subj of pubSubjects) validateSubject(subj);
  for (const subj of subSubjects) validateSubject(subj);

  nsc(["add", "user", "-a", account, "-n", name]);

  let credsContent: string;
  try {
    for (const subj of pubSubjects) {
      nsc(["edit", "user", "-a", account, "-n", name, "--allow-pub", subj]);
    }
    for (const subj of subSubjects) {
      nsc(["edit", "user", "-a", account, "-n", name, "--allow-sub", subj]);
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

// ── G1b: cross-account federated.> export/import (cortex#1117) ───────────────

const DEFAULT_FEDERATION_SUBJECT = "federated.>";

/**
 * Does the CURRENT nsc operator declare an account-JWT server URL?
 *
 * `nsc push` uploads account JWTs to a NATS account-resolver server (the
 * `account_server_url` baked into the operator JWT). A sovereign LOCAL
 * deployment (cortex `network provision`) runs a `resolver: MEMORY` nats-server
 * with the accounts preloaded into the config — there is NO account server, so
 * the operator JWT carries no `account_server_url` and `nsc push` fails hard
 * with "no account server url or nats-server url was provided by the operator
 * jwt".
 *
 * In that topology the local-store export/import mutation IS the federation
 * wiring; making it live is the caller's config-regen + nats-server restart
 * (cortex `network join` renders `resolver_preload`), NOT a push. So we detect
 * the no-account-server operator and SKIP push rather than abort a wiring that
 * already succeeded.
 *
 * Returns false (skip-safe) if the operator can't be described or the field is
 * absent; true only when a non-empty `account_server_url` is present.
 */
function operatorHasAccountServer(): boolean {
  let describeJson: string;
  try {
    describeJson = nsc(["describe", "operator", "-J"]);
  } catch (_err) {
    // Can't describe the operator — assume no account server (skip-safe).
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch (_err) {
    return false;
  }
  const url = (parsed as { nats?: { account_server_url?: unknown } }).nats?.account_server_url;
  return typeof url === "string" && url.trim().length > 0;
}

/**
 * Parses the JSON output of `nsc describe account -n <account> -J` and checks
 * whether an export for the given subject already exists.
 *
 * nsc encodes exports in the JWT claim at `.nats.exports[]`. Each export entry
 * has a `subject` field (a string, matching `nsc add export --subject`).
 */
function exportExistsOnAccount(describeJson: string, subject: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch (_err) {
    // Non-JSON output (some nsc versions emit text describe): treat as not present.
    return false;
  }
  const exports = (parsed as { nats?: { exports?: { subject?: unknown }[] } }).nats?.exports;
  if (!Array.isArray(exports)) return false;
  return exports.some((e) => e.subject === subject);
}

/**
 * Extracts the account public key (NKey, starts with "A") from an
 * `nsc describe account -n <account> -J` output.
 *
 * Returns the pubkey string if found, or null if the output is unparseable or
 * the key is absent (older nsc, non-JSON describe output, etc.).
 */
function extractAccountPubkey(describeJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch (_err) {
    return null;
  }
  const sub = (parsed as { sub?: unknown }).sub;
  if (typeof sub === "string" && sub.startsWith("A")) return sub;
  return null;
}

/**
 * Parses the JSON output of `nsc describe account -n <account> -J` and checks
 * whether an import from `fromAccount` on the given subject already exists.
 *
 * nsc encodes imports in the JWT claim at `.nats.imports[]`. Each import entry
 * has a `subject` field and an `account` field (the exporting account's NKey
 * pubkey, an "A"-prefixed 56-char string).
 *
 * M2 fix: match on BOTH subject AND source-account identity, not subject alone.
 * Subject-only matching is incorrect in the multi-peer hub topology: if to-account
 * already imports "federated.>" from peer A, a call with from-account=peer B would
 * silently skip adding the import from peer B, leaving peer B's traffic unrouted.
 *
 * `fromAccountPubkey` is the resolved pubkey of the exporting account (from
 * `nsc describe account -n <fromAccount> -J`). If null (pubkey could not be
 * resolved — e.g. older nsc), we fall back to subject-only matching and emit a
 * warning; this is safe-ish (worst-case an unnecessary re-add), but correct for
 * the common case where pubkeys are available.
 */
function importExistsOnAccount(
  describeJson: string,
  subject: string,
  fromAccountPubkey: string | null,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch (_err) {
    return false;
  }
  const imports = (parsed as { nats?: { imports?: { subject?: unknown; account?: unknown }[] } }).nats?.imports;
  if (!Array.isArray(imports)) return false;

  if (fromAccountPubkey === null) {
    // Pubkey unavailable — fall back to subject-only match with a warning.
    process.stderr.write(
      "[arc nats] WARNING: could not resolve fromAccount pubkey; falling back to subject-only import check. " +
      "Multi-peer hub topologies may skip necessary imports — upgrade nsc for reliable matching.\n",
    );
    return imports.some((i) => i.subject === subject);
  }

  // Match on BOTH subject AND source-account pubkey.
  return imports.some((i) => i.subject === subject && i.account === fromAccountPubkey);
}

export interface AddFederationExportOptions {
  /** The leaf-bound NSC account (exporting side). */
  fromAccount: string;
  /** The hub's destination NSC account (importing side). */
  toAccount: string;
  /** Subject pattern to export/import (default: "federated.>"). */
  subject?: string;
  /**
   * Add --service flag to nsc add export (for request/reply patterns).
   * Normally not needed for federated.> pub/sub.
   */
  service?: boolean;
  /**
   * When false (default), print the nsc commands that would run without
   * executing them. When true, execute the mutations and push both accounts.
   */
  apply?: boolean;
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface AddFederationExportResult {
  fromAccount: string;
  toAccount: string;
  subject: string;
  exportAdded: boolean;
  importAdded: boolean;
  exportAlreadyPresent: boolean;
  importAlreadyPresent: boolean;
  pushResult?: {
    fromAccount: "ok" | "skipped";
    toAccount: "ok" | "skipped";
  };
}

/**
 * Wire a cross-account federated.> export+import pair so that traffic entering
 * via the leaf-bound account (`fromAccount`) is routed into the hub's stack
 * account (`toAccount`).
 *
 * Atomically:
 *   1. describe fromAccount → check export exists
 *   2. nsc add export --account fromAccount --subject <subject> [--service]
 *   3. describe toAccount → check import exists
 *   4. nsc add import --account toAccount --from-account fromAccount --subject <subject>
 *   5. nsc push -a fromAccount && nsc push -a toAccount
 *
 * Idempotent: steps 2 and 4 are skipped when already present.
 * Dry-run by default (--apply to mutate).
 * Fail-closed: no rollback; a partial state (export without import) routes no
 * traffic and is recoverable by re-running (the describe-check skips the export).
 */
export function addFederationExport(opts: AddFederationExportOptions): AddFederationExportResult {
  const json = opts.json === true;
  const apply = opts.apply === true;
  const subject = opts.subject ?? DEFAULT_FEDERATION_SUBJECT;
  const { fromAccount, toAccount } = opts;

  ensureNscInstalled(json);

  // M1: validate account names BEFORE any nsc invocation to prevent flag
  // injection (e.g. "--all") and empty-string pushes that touch the whole
  // operator store. Both accounts are validated regardless of dry-run mode.
  validateAccountName(fromAccount);
  validateAccountName(toAccount);

  validateSubject(subject);

  // Case A: same account on both sides — no export/import needed.
  if (fromAccount === toAccount) {
    const msg = `fromAccount and toAccount are the same (${fromAccount}) — no export/import needed (intra-account routing).`;
    if (!json) console.log(msg);
    return {
      fromAccount,
      toAccount,
      subject,
      exportAdded: false,
      importAdded: false,
      exportAlreadyPresent: true,
      importAlreadyPresent: true,
    };
  }

  // ── Step 1: describe fromAccount — export idempotency + pubkey for M2 ───────
  // A single describe call serves double duty: (a) check whether the export
  // already exists, and (b) extract the account pubkey needed for the M2
  // source-account match in the import check (Step 3). This avoids a second
  // describe roundtrip for the pubkey.
  let exportAlreadyPresent = false;
  let fromAccountPubkey: string | null = null;
  try {
    const fromDesc = nsc(["describe", "account", "-n", fromAccount, "-J"]);
    exportAlreadyPresent = exportExistsOnAccount(fromDesc, subject);
    // M2: capture the pubkey for the import check below.
    fromAccountPubkey = extractAccountPubkey(fromDesc);
  } catch (_err) {
    // describe failed (account not found or nsc error) — exportAlreadyPresent
    // stays false; let add export surface the real error.
    // fromAccountPubkey stays null — importExistsOnAccount will warn + fall back.
  }

  // ── Step 2: add export (if not present) ────────────────────────────────────
  let exportAdded = false;
  if (!exportAlreadyPresent) {
    if (!apply) {
      if (!json) {
        console.log(`[dry-run] nsc add export --account ${fromAccount} --subject "${subject}"${opts.service ? " --service" : ""}`);
      }
    } else {
      const exportArgs: string[] = ["add", "export", "--account", fromAccount, "--subject", subject];
      if (opts.service) exportArgs.push("--service");
      nsc(exportArgs);
      exportAdded = true;
      if (!json) console.log(`Added export: ${fromAccount} → "${subject}"`);
    }
  } else {
    if (!json) console.log(`Export already present: ${fromAccount} → "${subject}" (no-op)`);
  }

  // ── Step 3: idempotency check — import on toAccount ────────────────────────
  // M2: match on BOTH subject AND source-account pubkey to correctly handle
  // multi-peer hub topologies where toAccount may already import the same
  // subject from a DIFFERENT peer. Subject-only matching would silently skip
  // adding the import from THIS fromAccount, leaving its traffic unrouted.
  let importAlreadyPresent = false;
  try {
    const toDesc = nsc(["describe", "account", "-n", toAccount, "-J"]);
    importAlreadyPresent = importExistsOnAccount(toDesc, subject, fromAccountPubkey);
  } catch (_err) {
    // describe failed — importAlreadyPresent stays false.
    // Let add import surface the real error.
  }

  // ── Step 4: add import (if not present) ────────────────────────────────────
  // nsc contract (`nsc add import --help`): the importing side names the SOURCE
  // account by its PUBKEY via `--src-account <A…>`, the exported subject via
  // `--remote-subject`, and the rewritten local subject via `--local-subject`.
  // There is NO `--from-account` flag and NO bare `--subject` on `add import`
  // (those belong to other verbs) — passing them makes nsc exit non-zero with
  // `unknown flag: --from-account`. `--service` mirrors the export side so a
  // service export is imported as a service import (rarely needed for the
  // federated.> stream default).
  let importAdded = false;
  if (!importAlreadyPresent) {
    if (!apply) {
      if (!json) {
        const srcRef = fromAccountPubkey ?? `<pubkey of ${fromAccount}>`;
        console.log(
          `[dry-run] nsc add import --account ${toAccount} --src-account ${srcRef}` +
          ` --remote-subject "${subject}" --local-subject "${subject}"${opts.service ? " --service" : ""}`,
        );
      }
    } else {
      // `--src-account` requires the exporting account's PUBKEY, captured in
      // Step 1. If it could not be resolved (older nsc / non-JSON describe), we
      // cannot construct a valid import — fail loudly rather than emit a broken
      // nsc invocation (a name in --src-account is silently mis-recorded). The
      // null-check here also NARROWS fromAccountPubkey to string for the argv.
      if (fromAccountPubkey === null) {
        throw new ArcNatsCommandError(
          "NSC_COMMAND_FAILED",
          `could not resolve the public key for source account "${fromAccount}" ` +
            `(needed for 'nsc add import --src-account'). Confirm the account exists ` +
            `and that this nsc emits JSON describe output (\`nsc describe account -n ${fromAccount} -J\`).`,
        );
      }
      const importArgs: string[] = [
        "add", "import",
        "--account", toAccount,
        "--src-account", fromAccountPubkey,
        "--remote-subject", subject,
        "--local-subject", subject,
      ];
      if (opts.service) importArgs.push("--service");
      nsc(importArgs);
      importAdded = true;
      if (!json) console.log(`Added import: ${toAccount} ← ${fromAccount} "${subject}"`);
    }
  } else {
    if (!json) console.log(`Import already present: ${toAccount} ← ${fromAccount} "${subject}" (no-op)`);
  }

  // ── Step 5: push both accounts (apply only) ────────────────────────────────
  // `nsc push` only applies to a nats-account-resolver deployment (the operator
  // JWT carries an `account_server_url`). A sovereign LOCAL stack runs a
  // `resolver: MEMORY` server with no account server — push there fails hard,
  // even though the export/import mutation already landed in the local store.
  // Detect that topology and SKIP push (the caller regenerates the MEMORY
  // resolver config + restarts the server — cortex `network join`).
  let pushResult: AddFederationExportResult["pushResult"];
  if (apply) {
    if (operatorHasAccountServer()) {
      if (!json) console.log(`Pushing ${fromAccount}...`);
      nsc(["push", "-a", fromAccount]);

      if (!json) console.log(`Pushing ${toAccount}...`);
      nsc(["push", "-a", toAccount]);

      pushResult = { fromAccount: "ok", toAccount: "ok" };
      if (!json) console.log("Both accounts pushed. Export/import wired and live.");
    } else {
      pushResult = { fromAccount: "skipped", toAccount: "skipped" };
      if (!json) {
        console.log(
          "Operator declares no account-JWT server (resolver: MEMORY deployment) — " +
          "skipping push. The export/import is recorded in the local nsc store; " +
          "regenerate the nats-server config + restart to make it live " +
          "(cortex `network join`).",
        );
      }
    }
  } else {
    if (!json) {
      console.log(`[dry-run] nsc push -a ${fromAccount}`);
      console.log(`[dry-run] nsc push -a ${toAccount}`);
      console.log(`\nRe-run with --apply to execute.`);
    }
    pushResult = { fromAccount: "skipped", toAccount: "skipped" };
  }

  return {
    fromAccount,
    toAccount,
    subject,
    exportAdded,
    importAdded,
    exportAlreadyPresent,
    importAlreadyPresent,
    pushResult,
  };
}

// ── arc#252: sovereign-operator topology (init-operator + add-account) ────────
//
// The two primitives `cortex network provision <stack>` (cortex#1139, Model-B
// sovereign federation) wraps alongside add-bot + add-federation-export to give
// a principal a one-command "stand up my stack to federate" flow. Each principal
// runs their OWN nsc operator and mints their own accounts (cortex ADR-0013);
// arc owns the nsc boundary, cortex orchestrates but never runs nsc itself.

// Operator names in the ecosystem are like "OP_ANDREAS". Permit a slightly wider
// charset than account names (which are strict UPPER_SNAKE) but still reject the
// empty string and flag-injection values (e.g. "--all", "--force") that nsc would
// otherwise treat as option names.
const OPERATOR_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function validateOperatorName(name: string): void {
  if (!name || !OPERATOR_NAME_RE.test(name)) {
    throw new ArcNatsCommandError(
      "VALIDATION_ERROR",
      `Invalid operator name: "${name}" — must match [A-Za-z][A-Za-z0-9_-]* and ` +
      `not be empty or flag-style (e.g. "--all").`,
    );
  }
}

/**
 * Resolve the current nsc operator from `nsc env` (table written to stderr).
 * Returns the operator name, or null when no operator is set / env is unreadable.
 */
function detectCurrentOperator(): string | null {
  let output: string;
  try {
    output = nscWithStderr(["env"]);
  } catch {
    // env unreadable (no nsc store yet) — caller falls back to requiring --name.
    return null;
  }
  const match = /Current Operator\s+\|[^|]*\|\s+(\S+)/.exec(output);
  return match ? match[1] : null;
}

/**
 * Look up the public key of an operator or account via `nsc describe <kind> -F sub`.
 *
 * Returns the parsed NKey pubkey if the entity exists, or `null` if `nsc describe`
 * fails (the entity does not exist, or nsc errored). Callers on the create path
 * treat `null` as "absent" and let the subsequent `nsc add` surface any real error.
 *
 * `-F sub` emits a JSON string literal (e.g. `"OD4D…"`); we JSON-parse it and fall
 * back to trimming the surrounding quotes if the output is not valid JSON.
 */
function tryGetPubKey(kind: "operator" | "account", name: string): string | null {
  let raw: string;
  try {
    raw = nsc(["describe", kind, "-n", name, "-F", "sub"]);
  } catch {
    // describe non-zero → entity absent. The catch is the existence signal.
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed.trim();
  } catch {
    // Non-JSON output (older nsc): fall through to quote-trim below.
  }
  return raw.replace(/^"|"$/g, "").trim();
}

/**
 * Resolve the nsc keystore base directory, mirroring `nsc env` precedence:
 *   $NKEYS_PATH → $XDG_DATA_HOME/nats/nsc/keys → ~/.local/share/nats/nsc/keys.
 */
function nscKeystoreBase(): string {
  const explicit = process.env.NKEYS_PATH;
  if (explicit && explicit.length > 0) return explicit;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "nats", "nsc", "keys");
  return join(homedir(), ".local", "share", "nats", "nsc", "keys");
}

/**
 * Compute the nsc keystore path of an operator seed for a given operator pubkey.
 * Keystore layout: `<base>/keys/O/<two chars after the 'O' prefix>/<pubkey>.nk`.
 */
function operatorSeedPath(pubKey: string): string {
  const shard = pubKey.slice(1, 3);
  return join(nscKeystoreBase(), "keys", "O", shard, `${pubKey}.nk`);
}

/**
 * Defensively re-assert mode 0o600 on the operator keystore seed.
 *
 * nsc already writes keystore seeds owner-only, but we re-assert it (mirrors the
 * identity-provision.ts seed-perm hardening) and report the path. Returns the
 * seed path if the file was found (and tightened), else null.
 */
function ensureOperatorSeedPermissions(pubKey: string): string | null {
  if (!pubKey) return null;
  const seedPath = operatorSeedPath(pubKey);
  if (!existsSync(seedPath)) return null;
  chmodSync(seedPath, 0o600);
  return seedPath;
}

export interface InitOperatorOptions {
  /** Operator name to create. When omitted, the current nsc operator is used. */
  name?: string;
  /** Recreate the operator even if it already exists (destructive — regenerates the identity key). */
  force?: boolean;
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface InitOperatorResult {
  operator: string;
  pubKey: string;
  created: boolean;
  alreadyExisted: boolean;
  seedPath: string | null;
}

/**
 * Create the principal's nsc operator if absent (arc#252).
 *
 * Idempotent: a no-op when the operator already exists (default never clobbers).
 * `--force` recreates an existing operator via `nsc add operator --force` (this
 * regenerates the operator identity key and orphans everything signed under the
 * old one — an explicit, destructive opt-in). The operator seed is managed by
 * nsc in its keystore at mode 0o600; we re-assert that and surface its path.
 */
export function initOperator(opts: InitOperatorOptions): InitOperatorResult {
  const json = opts.json === true;
  const force = opts.force === true;
  ensureNscInstalled(json);

  // Resolve the operator name: an explicit --name (validated), else the current
  // operator from `nsc env`. With neither, there is nothing to create idempotently.
  let name: string;
  if (opts.name && opts.name.length > 0) {
    validateOperatorName(opts.name);
    name = opts.name;
  } else {
    const current = detectCurrentOperator();
    if (!current) {
      throw new ArcNatsCommandError(
        "VALIDATION_ERROR",
        "no operator name given and no current nsc operator to infer from — pass --name <operator>.",
      );
    }
    validateOperatorName(current);
    name = current;
  }

  const existingPubKey = tryGetPubKey("operator", name);
  const alreadyExisted = existingPubKey !== null;

  let created = false;
  let pubKey = existingPubKey ?? "";

  if (!alreadyExisted || force) {
    const args = ["add", "operator", "-n", name];
    if (force) args.push("--force");
    nsc(args);
    created = true;
    const newPubKey = tryGetPubKey("operator", name);
    if (newPubKey === null) {
      throw new ArcNatsCommandError(
        "NSC_COMMAND_FAILED",
        `operator "${name}" was created but its public key could not be resolved via nsc describe.`,
      );
    }
    pubKey = newPubKey;
  }

  // Re-assert 0o600 on the keystore seed (nsc already writes it owner-only).
  const seedPath = ensureOperatorSeedPermissions(pubKey);

  if (!json) {
    if (created) {
      console.log(`${alreadyExisted ? "Recreated" : "Created"} nsc operator: ${name}`);
    } else {
      console.log(`nsc operator already exists: ${name} (no-op)`);
    }
    console.log(`  pubkey: ${pubKey}`);
    if (seedPath) console.log(`  seed: ${seedPath} (mode 600)`);
  }

  return { operator: name, pubKey, created, alreadyExisted, seedPath };
}

export interface AddAccountOptions {
  /** When true: suppress human-readable stdout; throw ArcNatsCommandError on failure. */
  json?: boolean;
}

export interface AddAccountResult {
  account: string;
  pubKey: string;
  created: boolean;
  alreadyExisted: boolean;
}

/**
 * Create an account `<name>` under the current nsc operator if absent (arc#252).
 *
 * Idempotent: a no-op when the account already exists, so it is safe to call
 * repeatedly with different names — cortex uses it for BOTH the federation
 * account and a per-stack agents account (ADR-0012 isolation, one agents account
 * per stack). Operates on the current operator context (set by `init-operator`
 * or `nsc env`), mirroring the existing add-bot "current context" assumption.
 */
export function addAccount(name: string, opts: AddAccountOptions): AddAccountResult {
  const json = opts.json === true;
  ensureNscInstalled(json);

  // Reuse the strict UPPER_SNAKE account-name guard — also rejects empty strings
  // and flag-injection values before any nsc invocation.
  validateAccountName(name);

  const existingPubKey = tryGetPubKey("account", name);
  const alreadyExisted = existingPubKey !== null;

  let created = false;
  let pubKey = existingPubKey ?? "";

  if (!alreadyExisted) {
    nsc(["add", "account", "-n", name]);
    created = true;
    const newPubKey = tryGetPubKey("account", name);
    if (newPubKey === null) {
      throw new ArcNatsCommandError(
        "NSC_COMMAND_FAILED",
        `account "${name}" was created but its public key could not be resolved via nsc describe.`,
      );
    }
    pubKey = newPubKey;
  }

  if (!json) {
    if (created) console.log(`Created nsc account: ${name}`);
    else console.log(`nsc account already exists: ${name} (no-op)`);
    console.log(`  pubkey: ${pubKey}`);
  }

  return { account: name, pubKey, created, alreadyExisted };
}
