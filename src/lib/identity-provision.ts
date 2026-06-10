/**
 * identity-provision.ts — agent identity provisioning at install (arc#228, F-6b).
 *
 * When an `arc install` lands a `type: agent` package, the agent instance needs
 * three things provisioned without manual post-install steps:
 *
 *   1. an NKey seed at the canonical NATS path (`~/.config/nats/<agent-id>.nk`,
 *      chmod 600) — the signing identity the agent's daemon binds to;
 *   2. a DID (`did:mf:<agent-id>`) — the agent's stable wire address; and
 *   3. a scaffolded instance-state directory (`~/.config/cortex/agents/<agent-id>/`)
 *      holding `state.sqlite`, `dashboard.md`, `CLAUDE.md`, `context/`, `retros/`.
 *
 * This module is the SINGLE dedicated home for that logic (per the F-6b merge-
 * coordination note: identity lives here; secrets — F-6e — live in their own
 * module; library ordering — F-6c — lives in install-transaction.ts). install.ts
 * wires it in as ONE clearly-commented hook call at the identity step, so the
 * concurrent arc install lanes touch non-adjacent insertion points.
 *
 * Grounding precedents:
 *   - cortex `scripts/lib/stack-identity-provision.sh` (cortex#324, cortex#563):
 *     canonical NKey path under `~/.config/nats/`, idempotent re-runs, and the
 *     cortex#563 fail-closed lesson — NEVER wire identity into a skeletal config
 *     that can't use it (there, a `nkey_seed_path` without a `stack.id` Zod-
 *     rejected at boot and crash-looped the service). Here the analogue is: never
 *     wire identity without an instance-state skeleton to anchor it.
 *   - `cortex stack create`'s born-aligned pattern: identity is generated AT
 *     install and wired idempotently, so drift can't form.
 *   - agent-state `skill/scripts/scaffold.ts` (`ScaffoldFolders`): the four-folder
 *     instance layout + operator-edited-files-are-never-overwritten model. arc
 *     does not take a hard runtime dependency on the agent-state repo's internal
 *     scripts; instead it reproduces the same on-disk layout so a later
 *     `agent-state scaffold` run on the same dir is a clean no-op.
 *
 * Fail-closed posture (cortex#563): every failure path is best-effort and returns
 * a result with `provisioned: false` + actionable guidance rather than throwing.
 * The install continues; the agent boots unidentified and the operator closes the
 * gap deliberately, instead of a half-provisioned crash loop.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { getPublicKeyAsync } from "@noble/ed25519";
// Shared agent-id grammar + display-name formatting (one source of truth, also
// used by src/commands/identity.ts) — nit (4) from the F-6b security review.
import { AGENT_ID_RE, formatDisplayName } from "./agent-naming.js";

/**
 * Derive an agent's DID from its canonical id.
 *
 * Canonical form `did:mf:<agent-id>` — no principal segment. Agents are named
 * entities (Luna, Echo, Forge, Pilot); the publishing stack encodes principal
 * via subject scope (`local.` / `federated.`), not the agent DID. The DID stays
 * stable across stack boundaries (a principal can move an agent to a different
 * stack without reissuing its identity). Matches arc `identity.ts` (`did:mf:<name>`)
 * and cortex CONTEXT.md (agent DIDs are distinct from stack DIDs).
 */
export function agentDidFromId(agentId: string): string {
  return `did:mf:${agentId}`;
}

/** Resolve the canonical NKey seed path for an agent id, honoring an override base. */
export function nkeyPathForAgent(agentId: string, natsDir?: string): string {
  const base = natsDir ?? join(homedir(), ".config", "nats");
  return join(base, `${agentId}.nk`);
}

/** Resolve the default instance-state directory for an agent id, honoring an override base. */
export function instanceDirForAgent(agentId: string, agentsBaseDir?: string): string {
  const base = agentsBaseDir ?? join(homedir(), ".config", "cortex", "agents");
  return join(base, agentId);
}

export interface ProvisionAction {
  kind: "created" | "skipped" | "warn";
  what: string;
  reason?: string;
}

export interface ProvisionIdentityOptions {
  /** Canonical agent identifier (manifest.identity.id or derived package slug). */
  agentId: string;
  /**
   * Absolute path to the instance-state directory. When omitted, defaults to
   * `~/.config/cortex/agents/<agentId>`. Mirrors the `MF_INSTANCE_DIR` contract.
   */
  instanceDir?: string;
  /** Override the `~/.config/nats` base (tests sandbox this). */
  natsDir?: string;
  /** Optional human-readable display name for templates (else derived from id). */
  displayName?: string;
  /** Optional principal id — logged for correlation only; NOT used for identity. */
  principal?: string;
  /** Suppress stdout action lines (non-interactive / test use). */
  quiet?: boolean;
}

export interface ProvisionIdentityResult {
  /** True iff identity (NKey + DID) was wired AND state was scaffolded. */
  provisioned: boolean;
  agentId: string;
  did: string;
  /** Path the NKey seed lives at (canonical), whether created or reused. */
  nkeySeedPath: string;
  /** Best-effort U-prefixed public key; empty when derivation isn't available. */
  nkeyPub: string;
  /** The instance-state directory operated on. */
  instanceDir: string;
  /** Per-action log, in order. */
  actions: ProvisionAction[];
  /** Set when a fail-closed guard fired; carries operator guidance. */
  warning?: string;
}

/**
 * Provision an agent's identity + state at install time. Idempotent and fail-
 * closed: safe to call on every install/upgrade.
 *
 * Flow (mirrors arc#228 §Specification step 3–4):
 *   1. Validate the agent id grammar (refuse rather than write a bad path).
 *   2. Fail-closed Rule 1 — instance-state skeleton must exist OR be creatable.
 *      arc owns the default instance dir, so "missing" means "we create it"; the
 *      guard fires only when creation itself fails (e.g. permission denied),
 *      where we WARN + skip identity wiring rather than orphan a seed.
 *   3. Generate the NKey seed if absent (nsc → nkeys.js → guidance), chmod 600.
 *      Idempotency Rule 2: an existing seed is reused, never regenerated.
 *   4. Best-effort derive the pubkey (empty is acceptable; cortex logs at boot).
 *   5. Scaffold the instance-state layout (operator-edited files never clobbered).
 *   6. Record provisioning in `state.sqlite` metadata (provisioned=1 + ts + DID).
 */
export async function provisionAgentIdentity(
  opts: ProvisionIdentityOptions,
): Promise<ProvisionIdentityResult> {
  const { agentId } = opts;
  const did = agentDidFromId(agentId);
  const instanceDir = opts.instanceDir ?? instanceDirForAgent(agentId);
  const nkeySeedPath = nkeyPathForAgent(agentId, opts.natsDir);
  const actions: ProvisionAction[] = [];

  const record = (kind: ProvisionAction["kind"], what: string, reason?: string): void => {
    actions.push(reason ? { kind, what, reason } : { kind, what });
    if (!opts.quiet) {
      const suffix = reason ? ` (${reason})` : "";
      const stream = kind === "warn" ? process.stderr : process.stdout;
      stream.write(`provision: ${kind} ${what}${suffix}\n`);
    }
  };

  const fail = (warning: string, nkeyPub = ""): ProvisionIdentityResult => {
    record("warn", "identity", warning);
    return {
      provisioned: false,
      agentId,
      did,
      nkeySeedPath,
      nkeyPub,
      instanceDir,
      actions,
      warning,
    };
  };

  // 1. Grammar guard — never write a seed/state path from a malformed id.
  if (!AGENT_ID_RE.test(agentId)) {
    return fail(
      `invalid agent id "${agentId}" — expected lowercase alphanumeric + single ` +
        `internal hyphens (no leading/trailing/double hyphens); skipping identity provisioning`,
    );
  }

  // 2. Fail-closed Rule 1 — instance-state skeleton must exist or be creatable.
  //    cortex#563 analogue: don't wire identity into a config/state that can't
  //    anchor it. arc owns the default dir, so we attempt creation; only a
  //    creation FAILURE (e.g. EACCES) trips the guard.
  if (!existsSync(instanceDir)) {
    try {
      // 0o700: the instance dir holds state.sqlite, which records the
      // nkey_seed_path + nkey_pub. Keep it owner-only (mirrors identity.ts's
      // ensureKeysDir pattern) so sibling-readable defaults don't leak the
      // location of the signing seed. (Security review nit (2).)
      mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
      chmodSync(instanceDir, 0o700); // recursive:true only modes the leaf; be explicit
      record("created", "instance-dir");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(
        `cannot create agent instance dir at ${instanceDir} (${msg}); ` +
          `refusing to wire identity without a state skeleton — set MF_INSTANCE_DIR ` +
          `to a writable path or fix permissions, then re-run`,
      );
    }
  } else {
    // Existing dir (upgrade path): re-assert owner-only perms defensively.
    chmodSync(instanceDir, 0o700);
  }

  // 3. NKey seed — generate if missing (idempotency Rule 2: reuse if present).
  if (existsSync(nkeySeedPath)) {
    // Defensively re-assert 0o600 on the upgrade path: a pre-existing seed that
    // was created (or copied) with looser perms must not silently stay
    // world/group-readable just because we're skipping generation. (Nit (3).)
    chmodSync(nkeySeedPath, 0o600);
    record("skipped", "nkey-seed", "exists");
  } else {
    const gen = generateNkeySeed(nkeySeedPath);
    if (!gen.ok) {
      // Self-contained generation only fails on a real crypto/IO error (e.g. the
      // seed path became unwritable). Emit guidance; the daemon boots unsigned
      // and the operator closes the gap deliberately rather than crash-looping.
      return fail(
        `could not generate an NKey seed for ${agentId} (${gen.reason}); ` +
          `cortex will publish unsigned until a seed exists at ${nkeySeedPath}`,
      );
    }
    record("created", "nkey-seed");
  }

  // 4. Best-effort pubkey derivation (empty acceptable — cortex logs at boot).
  const nkeyPub = (await derivePubkeyFromSeed(nkeySeedPath)) ?? "";

  // 5. Scaffold instance-state layout (operator-edited files never overwritten).
  scaffoldInstanceState(instanceDir, agentId, opts.displayName ?? formatDisplayName(agentId), record);

  // 6. Record provisioning in state.sqlite metadata.
  recordProvisioningMetadata(instanceDir, { did, nkeySeedPath, nkeyPub }, record);

  return {
    provisioned: true,
    agentId,
    did,
    nkeySeedPath,
    nkeyPub,
    instanceDir,
    actions,
  };
}

/**
 * Minimal manifest shape this module needs — kept structural (not an import of
 * the full ArcManifest) so the module stays decoupled and easy to unit-test.
 */
export interface AgentManifestLike {
  type: string;
  name: string;
  identity?: { id?: string; displayName?: string };
}

/**
 * install.ts wiring hook — the SINGLE entry point install calls at the identity
 * step. No-op for non-agent packages. For `type: agent`, resolves the canonical
 * agent id and invokes {@link provisionAgentIdentity}.
 *
 * Environment contract (arc#228 §Environment contract):
 *   - `MF_AGENT_ID`     overrides the manifest-derived agent id.
 *   - `MF_INSTANCE_DIR` overrides the default `~/.config/cortex/agents/<id>`.
 *   - `MF_NATS_DIR`     overrides the default `~/.config/nats` seed base (lets
 *                       a host/test redirect NKey storage; production leaves it).
 *   - `MF_PRINCIPAL`    logged for correlation only; never used for identity.
 *
 * Agent id resolution order: `MF_AGENT_ID` env → `manifest.identity.id` →
 * a lowercased, hyphen-normalized slug of `manifest.name`.
 *
 * Returns the provisioning result for agent packages, or null for non-agents.
 * Never throws — provisioning is best-effort and fail-closed.
 */
export async function maybeProvisionAgentIdentity(
  manifest: AgentManifestLike,
  opts: { quiet?: boolean } = {},
): Promise<ProvisionIdentityResult | null> {
  if (manifest.type !== "agent") return null;

  const agentId =
    envOrUndefined("MF_AGENT_ID") ?? manifest.identity?.id ?? slugify(manifest.name);

  return provisionAgentIdentity({
    agentId,
    instanceDir: envOrUndefined("MF_INSTANCE_DIR"),
    natsDir: envOrUndefined("MF_NATS_DIR"),
    displayName: manifest.identity?.displayName,
    principal: envOrUndefined("MF_PRINCIPAL"),
    quiet: opts.quiet,
  });
}

/**
 * Surface a provisioning result's fail-closed/skip outcome on the install log.
 *
 * Security-material rule (F-6b security review, MAJOR): a provisioning FAILURE
 * (bad id, EACCES, generation error → `provisioned: false`) must ALWAYS be
 * visible, even in non-interactive installs (`arc install --yes`, the dev-loop's
 * primary path). The per-action `record()` lines respect the `quiet` flag, but
 * a failure warning does NOT — it is written to stderr unconditionally so the
 * agent never silently boots unidentified without a trace in the install log.
 *
 * No-op for a null result (non-agent) or a successful provision.
 */
export function reportProvisioningResult(result: ProvisionIdentityResult | null): void {
  if (!result || result.provisioned) return;
  const warning =
    result.warning ?? "agent identity provisioning did not complete (booting unidentified)";
  process.stderr.write(`arc: agent identity NOT provisioned for ${result.agentId}: ${warning}\n`);
}

/** Read an env var, treating an empty string the same as unset (→ undefined). */
function envOrUndefined(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

/** Lowercase + collapse non-alnum runs to single hyphens; trim leading/trailing. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// NKey generation + pubkey derivation
// ---------------------------------------------------------------------------

interface NkeyGenResult {
  ok: boolean;
  reason?: string;
}

// NKey prefix bytes (NATS `nkeys` encoding). A seed encodes two prefix bytes:
//   byte0 = PREFIX_SEED (18) << 3            → base32 leading char 'S'
//   byte1 = PREFIX_USER (20) >> 5 | rest…    → second char 'U' for a user seed
// We implement the codec in-process (Ed25519 via @noble/ed25519 + base32/CRC16)
// so provisioning has NO external dependency on `nsc` or `nkeys.js` — it works
// in any environment (CI included). This is the cortex precedent's intent
// (centralized NKey generation) without its tool dependency.
const PREFIX_BYTE_SEED = 18 << 3; // 144 → 'S'
const PREFIX_BYTE_USER = 20 << 3; // 160 → 'U'

/**
 * Generate a fresh user-class NKey seed at `seedPath`, chmod 600.
 *
 * Self-contained: derives an Ed25519 keypair and encodes the 32-byte private
 * seed in the NATS NKey seed format (base32 + CRC16, 'SU…' prefix). No external
 * `nsc`/`nkeys.js` needed. Idempotency (reuse-if-present) is the caller's job.
 */
export function generateNkeySeed(seedPath: string): NkeyGenResult {
  mkdirSync(dirOf(seedPath), { recursive: true });
  try {
    const rawSeed = new Uint8Array(randomBytes(32));
    const encoded = encodeSeed(rawSeed, PREFIX_BYTE_USER);
    writeFileSync(seedPath, encoded + "\n", { mode: 0o600 });
    chmodSync(seedPath, 0o600);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Derive the U-prefixed public key from a seed file. Self-contained: decodes the
 * seed, derives the Ed25519 public key, and encodes it in the NKey public format.
 * Returns null only when the seed file is missing or malformed (the caller treats
 * an empty pubkey as acceptable).
 */
export async function derivePubkeyFromSeed(seedPath: string): Promise<string | null> {
  if (!existsSync(seedPath)) return null;
  try {
    const { rawSeed } = decodeSeed(readFileSync(seedPath, "utf-8").trim());
    const pub = await getPublicKeyAsync(rawSeed);
    return encodePublic(pub, PREFIX_BYTE_USER);
  } catch (_err) {
    // Safe to ignore: a malformed/unreadable seed yields an empty pubkey, which
    // is acceptable by contract (cortex derives + logs the pubkey at boot). The
    // seed file itself is untouched, so there is nothing to clean up here.
    return null;
  }
}

// --- NKey codec (base32 RFC4648 no-pad + CRC16-CCITT/XMODEM) ----------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode a 32-byte seed with the seed prefix + key-kind prefix + CRC16. */
function encodeSeed(rawSeed: Uint8Array, prefixKind: number): string {
  // NATS seed layout: b1 = SEED | (kind >> 5); b2 = (kind & 31) << 3.
  const b1 = PREFIX_BYTE_SEED | (prefixKind >> 5);
  const b2 = (prefixKind & 0b00011111) << 3;
  const payload = new Uint8Array(2 + rawSeed.length);
  payload[0] = b1;
  payload[1] = b2;
  payload.set(rawSeed, 2);
  return base32Encode(appendCrc(payload));
}

/** Decode a seed string back to its raw 32 bytes (validates CRC). */
function decodeSeed(seed: string): { rawSeed: Uint8Array } {
  const decoded = base32Decode(seed);
  const payload = stripCrc(decoded);
  // payload[0] carries SEED prefix bits; rawSeed is payload[2..].
  const rawSeed = payload.slice(2);
  if (rawSeed.length !== 32) throw new Error(`bad seed length ${rawSeed.length}`);
  return { rawSeed };
}

/** Encode a 32-byte public key with the given key-kind prefix + CRC16. */
function encodePublic(pub: Uint8Array, prefixKind: number): string {
  const payload = new Uint8Array(1 + pub.length);
  payload[0] = prefixKind;
  payload.set(pub, 1);
  return base32Encode(appendCrc(payload));
}

function appendCrc(data: Uint8Array): Uint8Array {
  const crc = crc16(data);
  const out = new Uint8Array(data.length + 2);
  out.set(data, 0);
  out[data.length] = crc & 0xff; // little-endian
  out[data.length + 1] = (crc >> 8) & 0xff;
  return out;
}

function stripCrc(data: Uint8Array): Uint8Array {
  const body = data.slice(0, data.length - 2);
  const expected = data[data.length - 2] | (data[data.length - 1] << 8);
  if (crc16(body) !== expected) throw new Error("nkey CRC mismatch");
  return body;
}

/** CRC16-CCITT (XMODEM) — the checksum NATS nkeys uses. */
function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(input: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Instance-state scaffold (mirrors agent-state ScaffoldFolders layout)
// ---------------------------------------------------------------------------

/**
 * Lay down the four-folder instance layout. Reproduces the agent-state
 * `scaffold.ts` on-disk model (so a later `agent-state scaffold` run is a no-op)
 * WITHOUT taking a hard dependency on that repo's scripts. Operator-edited files
 * (dashboard.md, CLAUDE.md, context/*) are never overwritten on re-runs.
 */
function scaffoldInstanceState(
  instanceDir: string,
  agentId: string,
  displayName: string,
  record: (kind: ProvisionAction["kind"], what: string, reason?: string) => void,
): void {
  // state.sqlite — created with the minimal AgentState-compatible metadata table.
  const statePath = join(instanceDir, "state.sqlite");
  const stateExisted = existsSync(statePath);
  ensureStateDb(statePath);
  record(stateExisted ? "skipped" : "created", "state.sqlite", stateExisted ? "exists" : undefined);

  writeIfAbsent(join(instanceDir, "dashboard.md"), dashboardTemplate(displayName, agentId), "dashboard.md", record);
  writeIfAbsent(join(instanceDir, "CLAUDE.md"), claudeMdTemplate(displayName, agentId), "CLAUDE.md", record);

  const contextDir = join(instanceDir, "context");
  if (!existsSync(contextDir)) {
    mkdirSync(contextDir, { recursive: true });
    record("created", "context/");
  } else {
    record("skipped", "context/", "exists");
  }
  writeIfAbsent(join(contextDir, "repos.md"), REPOS_PLACEHOLDER, "context/repos.md", record);
  writeIfAbsent(join(contextDir, "channels.md"), CHANNELS_PLACEHOLDER, "context/channels.md", record);

  const retrosDir = join(instanceDir, "retros");
  if (!existsSync(retrosDir)) {
    mkdirSync(retrosDir, { recursive: true });
    record("created", "retros/");
  } else {
    record("skipped", "retros/", "exists");
  }
}

/**
 * Create state.sqlite with a `metadata` key/value table if it doesn't yet hold
 * one. We deliberately keep this minimal and additive: AgentState's own
 * migration 0001 (work_items/events) is applied later by `agent-state scaffold`
 * or by the agent's first run via openState(); creating an empty DB here is
 * forward-compatible (schema_migrations bookkeeping makes that idempotent).
 */
function ensureStateDb(statePath: string): void {
  const db = new Database(statePath, { create: true });
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS provisioning_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  } finally {
    db.close();
  }
  // state.sqlite records nkey_seed_path + nkey_pub — keep it owner-only (the DB
  // is created with the process umask, typically 0o644). (Security review nit (2).)
  chmodSync(statePath, 0o600);
}

/**
 * Record provisioning facts into state.sqlite metadata. Idempotent (UPSERT).
 * Marks the instance `provisioned=1` with a timestamp + DID so a re-run can
 * detect prior provisioning and downstream tooling can read the wired identity.
 */
function recordProvisioningMetadata(
  instanceDir: string,
  facts: { did: string; nkeySeedPath: string; nkeyPub: string },
  record: (kind: ProvisionAction["kind"], what: string, reason?: string) => void,
): void {
  const statePath = join(instanceDir, "state.sqlite");
  const db = new Database(statePath, { create: true });
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS provisioning_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const upsert = db.prepare(
      "INSERT INTO provisioning_metadata (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    upsert.run("provisioned", "1");
    upsert.run("provisioned_at", new Date().toISOString());
    upsert.run("did", facts.did);
    upsert.run("nkey_seed_path", facts.nkeySeedPath);
    if (facts.nkeyPub) upsert.run("nkey_pub", facts.nkeyPub);
  } finally {
    db.close();
  }
  record("created", "provisioning-metadata");
}

function writeIfAbsent(
  path: string,
  contents: string,
  label: string,
  record: (kind: ProvisionAction["kind"], what: string, reason?: string) => void,
): void {
  if (existsSync(path)) {
    record("skipped", label, "exists");
    return;
  }
  writeFileSync(path, contents);
  record("created", label);
}

// ---------------------------------------------------------------------------
// helpers + templates
// ---------------------------------------------------------------------------

function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function dashboardTemplate(displayName: string, agentId: string): string {
  return `# ${displayName} dashboard

_Agent: \`${agentId}\` · DID: \`${agentDidFromId(agentId)}\`_

> Regenerated by \`RegenerateDashboard\`. Do not hand-edit — manual changes will be overwritten.

## Pending work

_no work yet_

## In flight

_no work yet_

## Recently resolved

_no work yet_
`;
}

function claudeMdTemplate(displayName: string, agentId: string): string {
  return `# CLAUDE.md — ${displayName} instance bridge

This file orients Claude Code sessions launched against this agent instance.

- **Agent:** \`${agentId}\`
- **DID:** \`${agentDidFromId(agentId)}\`
- **Instance dir:** this directory (\`MF_INSTANCE_DIR\`)

## State

- \`state.sqlite\` — provisioning metadata + (after \`agent-state scaffold\`)
  work_items + events tables. Managed by the AgentState bundle's scripts.
  Never hand-edit.
- \`dashboard.md\` — generated view of current work.
- \`retros/\` — weekly ISO-week retro markdown files.
- \`context/repos.md\` — repositories in scope for this agent.
- \`context/channels.md\` — Discord channels this agent monitors.
`;
}

const REPOS_PLACEHOLDER = `# Repositories in scope

_List the repositories this agent owns or watches. One per line, short name first._

- \`example-repo\` — what this repo is and why this agent cares.
`;

const CHANNELS_PLACEHOLDER = `# Discord channels in scope

_List the Discord channels and threads this agent monitors or posts to._

- \`#example-channel\` — purpose.
`;
