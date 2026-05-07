/**
 * arc nats — NATS bot identity management.
 *
 * Wraps NSC to provision per-bot NATS users under an operator's account.
 * Part of grove#320 (bot-level AAA) — operator-level infrastructure tooling.
 *
 * Commands:
 *   arc nats add-bot <name>       Issue a new per-bot NATS user
 *   arc nats reissue-bot <name>   Revoke + re-issue credentials
 *   arc nats list-bots            List bot users under current account
 *   arc nats remove-bot <name>    Revoke a bot user
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CREDS_DIR = join(homedir(), ".config", "nats");
const NAMING_RE = /^[a-z][a-z0-9-]*$/;

function nsc(args: string): string {
  try {
    // nsc writes some output to stderr (e.g., `nsc env`), merge both streams
    return execSync(`nsc ${args} 2>&1`, { encoding: "utf-8" }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    const msg = err.stderr?.trim() || err.stdout?.trim() || "unknown error";
    throw new Error(`nsc ${args.split(" ")[0]} failed: ${msg}`);
  }
}

export function ensureNscInstalled(): void {
  try {
    execSync("which nsc", { encoding: "utf-8" });
  } catch {
    console.error("Error: nsc not found on PATH.");
    console.error("Install: brew install nats-io/nats-tools/nsc");
    console.error("  or: https://github.com/nats-io/nsc");
    process.exit(1);
  }
}

export function detectAccount(): string {
  const env = nsc("env");
  const match = env.match(/Current Account\s+\|[^|]*\|\s+(\S+)/);
  if (match) return match[1];
  throw new Error("Cannot detect NSC account. Run: nsc env -a <account>");
}

function credsPath(name: string): string {
  return join(CREDS_DIR, `${name}.creds`);
}

function userExists(account: string, name: string): boolean {
  try {
    nsc(`describe user -a ${account} -n ${name}`);
    return true;
  } catch {
    return false;
  }
}

export interface AddBotOptions {
  account?: string;
  pub?: string;
  sub?: string;
  output?: string;
  force?: boolean;
}

export function addBot(name: string, opts: AddBotOptions): void {
  ensureNscInstalled();

  if (!NAMING_RE.test(name)) {
    console.error(`Error: bot name "${name}" must be lowercase alphanumeric + hyphens.`);
    process.exit(1);
  }

  const account = opts.account ?? detectAccount();
  const outPath = opts.output ?? credsPath(name);

  if (existsSync(outPath) && !opts.force) {
    console.error(`Error: credentials exist at ${outPath}. Use --force to overwrite.`);
    process.exit(1);
  }

  if (userExists(account, name)) {
    if (!opts.force) {
      console.error(`Error: user "${name}" exists under "${account}". Use --force to re-create.`);
      process.exit(1);
    }
    nsc(`delete user -a ${account} -n ${name}`);
    console.log(`Removed existing user: ${name}`);
  }

  nsc(`add user -a ${account} -n ${name}`);
  console.log(`Created NATS user: ${name} (account: ${account})`);

  if (opts.pub) {
    for (const subj of opts.pub.split(",").map((s) => s.trim())) {
      nsc(`edit user -a ${account} -n ${name} --allow-pub "${subj}"`);
    }
    console.log(`  publish: ${opts.pub}`);
  }

  if (opts.sub) {
    for (const subj of opts.sub.split(",").map((s) => s.trim())) {
      nsc(`edit user -a ${account} -n ${name} --allow-sub "${subj}"`);
    }
    console.log(`  subscribe: ${opts.sub}`);
  }

  const creds = nsc(`generate creds -a ${account} -n ${name}`);
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, creds, { mode: 0o600 });
  console.log(`  credentials: ${outPath} (mode 600)`);
}

export interface ReissueBotOptions {
  account?: string;
  output?: string;
}

export function reissueBot(name: string, opts: ReissueBotOptions): void {
  ensureNscInstalled();
  const account = opts.account ?? detectAccount();
  const outPath = opts.output ?? credsPath(name);

  if (!userExists(account, name)) {
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  nsc(`delete user -a ${account} -n ${name}`);
  nsc(`add user -a ${account} -n ${name}`);

  const creds = nsc(`generate creds -a ${account} -n ${name}`);
  writeFileSync(outPath, creds, { mode: 0o600 });

  console.log(`Re-issued credentials for ${name}`);
  console.log(`  credentials: ${outPath} (mode 600)`);
  console.log(`  Note: old credentials are now invalid.`);
}

export function listBots(account?: string): void {
  ensureNscInstalled();
  const acct = account ?? detectAccount();
  console.log(nsc(`list users -a ${acct}`));
}

export interface RemoveBotOptions {
  account?: string;
  deleteCreds?: boolean;
}

export function removeBot(name: string, opts: RemoveBotOptions): void {
  ensureNscInstalled();
  const account = opts.account ?? detectAccount();

  if (!userExists(account, name)) {
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  nsc(`delete user -a ${account} -n ${name}`);
  console.log(`Removed user: ${name} (account: ${account})`);

  if (opts.deleteCreds) {
    const path = credsPath(name);
    if (existsSync(path)) {
      unlinkSync(path);
      console.log(`Deleted credentials: ${path}`);
    }
  }
}
