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
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

let runner: NscRunner = defaultRunner;

/**
 * Test-only hook to swap the nsc runner. Pass `null` to restore the default.
 * Do NOT call from production code paths.
 */
export function __setNscRunnerForTests(next: NscRunner | null): void {
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
 */
export function __setNscInstallCheckForTests(next: (() => boolean) | null): void {
  nscInstallCheck = next ?? (() => Bun.spawnSync(["which", "nsc"], { stdout: "pipe" }).exitCode === 0);
}

export function ensureNscInstalled(): void {
  if (!nscInstallCheck()) {
    console.error("Error: nsc not found on PATH.");
    console.error("Install: brew install nats-io/nats-tools/nsc");
    process.exit(1);
  }
}

function validateBotName(name: string): void {
  if (!NAMING_RE.test(name)) {
    console.error(`Error: bot name "${name}" must be lowercase alphanumeric + hyphens.`);
    process.exit(1);
  }
}

function validateSubject(subject: string): void {
  if (!NATS_SUBJECT_RE.test(subject)) {
    throw new Error(`Invalid NATS subject: "${subject}" — only alphanumeric, dots, wildcards, hyphens, underscores allowed`);
  }
}

export function detectAccount(): string {
  for (const candidate of NSC_CONFIG_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const config = JSON.parse(readFileSync(candidate, "utf-8"));
      if (config.account && typeof config.account === "string") {
        return config.account;
      }
    } catch {
      continue;
    }
  }
  // Fallback: parse nsc env output (env writes to stderr)
  const output = nscWithStderr(["env"]);
  const match = output.match(/Current Account\s+\|[^|]*\|\s+(\S+)/);
  if (match) return match[1];
  throw new Error("Cannot detect NSC account. Run: nsc env -a <account>");
}

function defaultCredsPath(name: string): string {
  return join(DEFAULT_CREDS_DIR, `${name}.creds`);
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
    throw new Error(`Failed to parse nsc describe user JSON for "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const sub = (parsed as { sub?: unknown }).sub;
  if (typeof sub !== "string" || !sub.startsWith("U")) {
    throw new Error(`Could not extract user public key for "${name}" (expected U-prefixed NKey in 'sub' claim).`);
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
function revokeAndPushUser(account: string, name: string): void {
  const pubKey = getUserPubKey(account, name);

  // Add to revocation map (keyed by pubkey so it survives local user delete).
  try {
    nsc(["revocations", "add-user", "-a", account, "-u", pubKey]);
  } catch (err) {
    throw new Error(
      `Failed to add revocation for user "${name}" (${pubKey}): ${err instanceof Error ? err.message : String(err)}. ` +
      `The user JWT is STILL VALID on the bus.`
    );
  }

  // Push the updated account JWT so the NATS server picks up the revocation.
  // If this fails, the JWT remains valid server-side — abort loudly.
  try {
    nsc(["push", "-a", account]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Server-side revoke failed: ${reason}. The user JWT is STILL VALID on the bus. ` +
      `Resolve connectivity and retry.`
    );
  }
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
}

export async function addBot(name: string, opts: AddBotOptions): Promise<void> {
  ensureNscInstalled();

  validateBotName(name);

  const account = opts.account ?? detectAccount();
  const outPath = opts.output ?? defaultCredsPath(name);

  if (existsSync(outPath) && !opts.force) {
    console.error(`Error: credentials exist at ${outPath}. Use --force to overwrite.`);
    process.exit(1);
  }

  if (userExists(account, name)) {
    if (!opts.force) {
      console.error(`Error: user "${name}" exists under "${account}". Use --force to re-create.`);
      process.exit(1);
    }
    nsc(["delete", "user", "-a", account, "-n", name]);
    console.log(`Removed existing user: ${name}`);
  }

  nsc(["add", "user", "-a", account, "-n", name]);

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

    const creds = nsc(["generate", "creds", "-a", account, "-n", name]);
    writeCredsFile(outPath, creds);
  } catch (err) {
    try { nsc(["delete", "user", "-a", account, "-n", name]); } catch { /* best effort */ }
    throw new Error(`Failed to configure user "${name}" — rolled back. Cause: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Created NATS user: ${name} (account: ${account})`);
  if (opts.pub) console.log(`  publish: ${opts.pub}`);
  if (opts.sub) console.log(`  subscribe: ${opts.sub}`);
  console.log(`  credentials: ${outPath} (mode 600)`);

  if (opts.withIdentity) {
    await generateIdentity(name, account, { force: opts.force });
  }
}

export interface ReissueBotOptions {
  account?: string;
  output?: string;
}

export function reissueBot(name: string, opts: ReissueBotOptions): void {
  ensureNscInstalled();
  validateBotName(name);
  const account = opts.account ?? detectAccount();
  const outPath = opts.output ?? defaultCredsPath(name);

  if (!userExists(account, name)) {
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  // nsc requires delete+add for new keys (no in-place rekey).
  // Back up old creds file before the destructive delete.
  if (existsSync(outPath)) {
    const backup = `${outPath}.bak`;
    writeFileSync(backup, readFileSync(outPath));
    chmodSync(backup, 0o600);
    console.log(`  backup: ${backup}`);
  }

  // Revoke the OLD user pubkey server-side BEFORE delete+add. If this fails
  // we abort — leaking the old creds is the whole reason for the reissue.
  try {
    revokeAndPushUser(account, name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  nsc(["delete", "user", "-a", account, "-n", name]);

  try {
    nsc(["add", "user", "-a", account, "-n", name]);
    const creds = nsc(["generate", "creds", "-a", account, "-n", name]);
    writeCredsFile(outPath, creds);
  } catch (err) {
    console.error(`CRITICAL: failed to re-create user "${name}" after delete.`);
    if (existsSync(`${outPath}.bak`)) {
      console.error(`Old credentials backed up at: ${outPath}.bak`);
      console.error(
        `Note: old creds invalidated via revocations push above; the backup ` +
        `captures the old JWT for forensics only (it's revoked server-side ` +
        `and will be rejected by NATS).`
      );
    }
    console.error(`Manual recovery: nsc add user -a ${account} -n ${name}`);
    console.error(`Cause: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Clean up backup on success
  try { unlinkSync(`${outPath}.bak`); } catch { /* ok if no backup */ }

  console.log(`Re-issued credentials for ${name}`);
  console.log(`  credentials: ${outPath} (mode 600)`);
  console.log(`  Note: old credentials revoked server-side and pushed to NATS.`);
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
}

export interface SetupOperatorOptions {
  force?: boolean;
}

export async function setupOperator(account: string, botNames: string[], opts: SetupOperatorOptions): Promise<void> {
  ensureNscInstalled();

  console.log(`Setting up ${botNames.length} bot(s) for operator ${account}...\n`);

  const results: { name: string; ok: boolean; error?: string }[] = [];

  for (const name of botNames) {
    try {
      console.log(`── ${name} ──`);
      await addBot(name, { account, withIdentity: true, force: opts.force });
      console.log();
      results.push({ name, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}\n`);
      results.push({ name, ok: false, error: msg });
    }
  }

  console.log(`\n── Summary ──`);
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  console.log(`  ${ok.length}/${botNames.length} bots provisioned`);
  if (failed.length > 0) {
    console.log(`  Failed: ${failed.map(r => r.name).join(", ")}`);
  }
  console.log(`\nNext steps:`);
  console.log(`  1. arc identity export > ${account.toLowerCase()}-principals.json`);
  console.log(`  2. Send the file to other operators`);
  console.log(`  3. arc identity import <other-operator>-principals.json`);
}

export function removeBot(name: string, opts: RemoveBotOptions): void {
  ensureNscInstalled();
  validateBotName(name);
  const account = opts.account ?? detectAccount();

  if (!userExists(account, name)) {
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  // Server-side revoke FIRST: add user pubkey to the account's revocation
  // map and push the updated account JWT. If this fails we abort BEFORE
  // deleting locally — a half-done revoke leaves a still-valid JWT on the
  // bus and the operator unaware.
  try {
    revokeAndPushUser(account, name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  nsc(["delete", "user", "-a", account, "-n", name]);
  console.log(`Revoked and removed user: ${name} (account: ${account})`);

  if (opts.deleteCreds) {
    const path = opts.output ?? defaultCredsPath(name);
    if (existsSync(path)) {
      unlinkSync(path);
      console.log(`Deleted credentials: ${path}`);
    } else {
      console.log(`Warning: no credentials file at ${path} (custom -o path used at creation?)`);
    }
  }
}
