/**
 * arc nats — NATS bot identity management.
 *
 * Wraps NSC to provision per-bot NATS users under an operator's account.
 * Part of grove#320 (bot-level AAA) — operator-level infrastructure tooling.
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const CREDS_DIR = join(homedir(), ".config", "nats");
const NAMING_RE = /^[a-z][a-z0-9-]*$/;
const NATS_SUBJECT_RE = /^[a-zA-Z0-9.*>_-]+$/;

function nsc(args: string[]): string {
  const result = spawnSync("nsc", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`nsc ${args[0]} failed: ${msg}`);
  }
  // nsc writes some output to stderr (e.g., `nsc env`)
  return (result.stdout + result.stderr).trim();
}

export function ensureNscInstalled(): void {
  const result = spawnSync("which", ["nsc"], { encoding: "utf-8" });
  if (result.status !== 0) {
    console.error("Error: nsc not found on PATH.");
    console.error("Install: brew install nats-io/nats-tools/nsc");
    process.exit(1);
  }
}

function validateSubject(subject: string): void {
  if (!NATS_SUBJECT_RE.test(subject)) {
    throw new Error(`Invalid NATS subject: "${subject}" — only alphanumeric, dots, wildcards, hyphens, underscores allowed`);
  }
}

export function detectAccount(): string {
  const output = nsc(["env"]);
  const match = output.match(/Current Account\s+\|[^|]*\|\s+(\S+)/);
  if (match) return match[1];
  throw new Error("Cannot detect NSC account. Run: nsc env -a <account>");
}

function credsPath(name: string): string {
  return join(CREDS_DIR, `${name}.creds`);
}

function userExists(account: string, name: string): boolean {
  try {
    nsc(["describe", "user", "-a", account, "-n", name]);
    return true;
  } catch {
    return false;
  }
}

function ensureCredsDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
}

function writeCredsFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
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
    nsc(["delete", "user", "-a", account, "-n", name]);
    console.log(`Removed existing user: ${name}`);
  }

  nsc(["add", "user", "-a", account, "-n", name]);
  console.log(`Created NATS user: ${name} (account: ${account})`);

  if (opts.pub) {
    for (const subj of opts.pub.split(",").map((s) => s.trim())) {
      validateSubject(subj);
      nsc(["edit", "user", "-a", account, "-n", name, "--allow-pub", subj]);
    }
    console.log(`  publish: ${opts.pub}`);
  }

  if (opts.sub) {
    for (const subj of opts.sub.split(",").map((s) => s.trim())) {
      validateSubject(subj);
      nsc(["edit", "user", "-a", account, "-n", name, "--allow-sub", subj]);
    }
    console.log(`  subscribe: ${opts.sub}`);
  }

  const creds = nsc(["generate", "creds", "-a", account, "-n", name]);
  ensureCredsDir(outPath);
  writeCredsFile(outPath, creds);
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

  // Capture existing user config before delete for rollback
  let existingConfig: string;
  try {
    existingConfig = nsc(["describe", "user", "-a", account, "-n", name, "--json"]);
  } catch {
    console.error(`Error: cannot read existing user config for "${name}".`);
    process.exit(1);
  }

  nsc(["delete", "user", "-a", account, "-n", name]);

  try {
    nsc(["add", "user", "-a", account, "-n", name]);
  } catch (err) {
    console.error(`Error: failed to re-create user "${name}". Previous config saved to stderr.`);
    process.stderr.write(`Previous user config:\n${existingConfig}\n`);
    process.exit(1);
  }

  const creds = nsc(["generate", "creds", "-a", account, "-n", name]);
  ensureCredsDir(outPath);
  writeCredsFile(outPath, creds);

  console.log(`Re-issued credentials for ${name}`);
  console.log(`  credentials: ${outPath} (mode 600)`);
  console.log(`  Note: old credentials are now invalid.`);
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

export function removeBot(name: string, opts: RemoveBotOptions): void {
  ensureNscInstalled();
  const account = opts.account ?? detectAccount();

  if (!userExists(account, name)) {
    console.error(`Error: user "${name}" not found under "${account}".`);
    process.exit(1);
  }

  nsc(["delete", "user", "-a", account, "-n", name]);
  console.log(`Removed user: ${name} (account: ${account})`);

  if (opts.deleteCreds) {
    const path = opts.output ?? credsPath(name);
    if (existsSync(path)) {
      unlinkSync(path);
      console.log(`Deleted credentials: ${path}`);
    } else {
      console.log(`Warning: no credentials file at ${path} (custom -o path used at creation?)`);
    }
  }
}
