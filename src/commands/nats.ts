/**
 * arc nats — NATS bot identity management.
 *
 * Wraps NSC to provision per-bot NATS users under an operator's account.
 * Part of grove#320 (bot-level AAA) — operator-level infrastructure tooling.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CREDS_DIR = join(homedir(), ".config", "nats");
const NAMING_RE = /^[a-z][a-z0-9-]*$/;
const NATS_SUBJECT_RE = /^[a-zA-Z0-9.*>_-]+$/;

// NSC config can live in several locations depending on version/platform
const NSC_CONFIG_CANDIDATES = [
  join(homedir(), ".config", "nats", "nsc", "nsc.json"),
  join(homedir(), ".nsc", "nsc.json"),
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nsc", "nsc.json"),
];

function nsc(args: string[]): string {
  const result = Bun.spawnSync(["nsc", ...args], { stderr: "pipe", stdout: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`nsc ${args[0]} failed: ${stderr || stdout || "unknown error"}`);
  }
  return stdout;
}

function nscWithStderr(args: string[]): string {
  const result = Bun.spawnSync(["nsc", ...args], { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    throw new Error(`nsc ${args[0]} failed: ${stderr || stdout || "unknown error"}`);
  }
  return (result.stdout.toString() + result.stderr.toString()).trim();
}

export function ensureNscInstalled(): void {
  const result = Bun.spawnSync(["which", "nsc"], { stdout: "pipe" });
  if (result.exitCode !== 0) {
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

export function addBot(name: string, opts: AddBotOptions): void {
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
    import("./identity").then(({ generateIdentity }) =>
      generateIdentity(name, account, { force: opts.force }),
    ).catch((err: Error) => {
      console.error(`Warning: identity generation failed: ${err.message}`);
      console.error("NATS credentials were created successfully. Run 'arc identity generate' to retry.");
    });
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

  nsc(["delete", "user", "-a", account, "-n", name]);

  try {
    nsc(["add", "user", "-a", account, "-n", name]);
    const creds = nsc(["generate", "creds", "-a", account, "-n", name]);
    writeCredsFile(outPath, creds);
  } catch (err) {
    console.error(`CRITICAL: failed to re-create user "${name}" after delete.`);
    if (existsSync(`${outPath}.bak`)) {
      console.error(`Old credentials backed up at: ${outPath}.bak`);
      console.error(`Note: old creds are invalidated — backup is for reference only.`);
    }
    console.error(`Manual recovery: nsc add user -a ${account} -n ${name}`);
    console.error(`Cause: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Clean up backup on success
  try { unlinkSync(`${outPath}.bak`); } catch { /* ok if no backup */ }

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

export interface SetupOperatorOptions {
  force?: boolean;
}

export async function setupOperator(account: string, botNames: string[], opts: SetupOperatorOptions): Promise<void> {
  ensureNscInstalled();

  console.log(`Setting up ${botNames.length} bot(s) for operator ${account}...\n`);

  const results: { name: string; ok: boolean; error?: string }[] = [];

  const { generateIdentity } = await import("./identity");

  for (const name of botNames) {
    try {
      console.log(`── ${name} ──`);
      addBot(name, { account, force: opts.force });
      await generateIdentity(name, account, { force: opts.force });
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

  nsc(["delete", "user", "-a", account, "-n", name]);
  console.log(`Removed user: ${name} (account: ${account})`);

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
