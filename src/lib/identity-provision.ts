/**
 * identity-provision.ts — agent identity provisioning at install (arc#228, F-6b;
 * opt-in state arc#281).
 *
 * When an `arc install` lands a `type: agent` package, the agent instance needs
 * its identity provisioned without manual post-install steps:
 *
 *   1. an NKey seed at the canonical NATS path (`~/.config/nats/<agent-id>.nk`,
 *      chmod 600) — the signing identity the agent's daemon binds to;
 *   2. a DID (`did:mf:<agent-id>`) — the agent's stable wire address.
 *
 * Identity (1 + 2) is provisioned for EVERY agent, unconditionally.
 *
 * A third artifact — a scaffolded instance-state directory
 * (`~/.config/cortex/agents/<agent-id>/` holding `state.sqlite`, `dashboard.md`,
 * `CLAUDE.md`, `context/`, `retros/`) — is now OPT-IN (arc#281). The platform
 * contract is stateless-by-default (`forge/design/agent-platform.md` §state):
 * only agents whose manifest declares `state: { blueprint, version }` get the
 * scaffold. Stateless agents take zero state code paths (matches cortex#1720/
 * #1721, which made the same default cortex-side). The caller signals opt-in via
 * `ProvisionIdentityOptions.scaffoldState`.
 *
 * This module is the SINGLE dedicated home for that logic (per the F-6b merge-
 * coordination note: identity lives here; secrets — F-6e — live in their own
 * module; library ordering — F-6c — lives in install-transaction.ts). install.ts
 * wires it in as ONE clearly-commented hook call at the identity step, so the
 * concurrent arc install lanes touch non-adjacent insertion points.
 *
 * Idempotency record (arc#281, option (a)): provisioning was previously recorded
 * ONLY in `state.sqlite` metadata (`provisioned=1`), which a stateless agent
 * never has. It is now recorded in an arc-owned sidecar JSON at
 * `~/.config/metafactory/agents/<agent-id>.provision.json`, written for ALL
 * agents. The sidecar is the CANONICAL provisioning record and idempotency
 * anchor. Stateful agents ALSO keep the `state.sqlite` metadata record (least
 * churn — downstream tooling that reads it keeps working), but the sidecar is
 * the source of truth.
 *
 * Grounding precedents:
 *   - cortex `scripts/lib/stack-identity-provision.sh` (cortex#324, cortex#563):
 *     canonical NKey path under `~/.config/nats/`, idempotent re-runs, and the
 *     cortex#563 fail-closed lesson — NEVER wire identity into a skeletal config
 *     that can't use it (there, a `nkey_seed_path` without a `stack.id` Zod-
 *     rejected at boot and crash-looped the service). Here the analogue is: never
 *     wire identity without a place to ANCHOR the provisioning record — which is
 *     now the arc-owned sidecar dir, not the (now-optional) state skeleton.
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

/**
 * Resolve the arc-owned provisioning-sidecar path for an agent id (arc#281,
 * option (a)). Canonical location `~/.config/metafactory/agents/<id>.provision.json`
 * — an arc-owned dir, so it exists for stateless agents that never get a cortex
 * instance dir. Honors an override base (tests + the `MF_SIDECAR_DIR` contract).
 */
export function provisionSidecarPathForAgent(agentId: string, sidecarDir?: string): string {
  const base = sidecarDir ?? join(homedir(), ".config", "metafactory", "agents");
  return join(base, `${agentId}.provision.json`);
}

export interface ProvisionAction {
  kind: "created" | "updated" | "skipped" | "warn";
  what: string;
  reason?: string;
}

export interface ProvisionIdentityOptions {
  /** Canonical agent identifier (manifest.identity.id or derived package slug). */
  agentId: string;
  /**
   * Whether to scaffold the instance-state directory (arc#281). Opt-in: true
   * ONLY when the manifest declares `state: { blueprint, version }`. When false
   * (the default), the agent is stateless — identity is still provisioned and
   * the provisioning sidecar is written, but NO instance dir / state.sqlite /
   * dashboard/context/retros are created.
   */
  scaffoldState?: boolean;
  /**
   * Absolute path to the instance-state directory. When omitted, defaults to
   * `~/.config/cortex/agents/<agentId>`. Mirrors the `MF_INSTANCE_DIR` contract.
   * Only used when `scaffoldState` is true.
   */
  instanceDir?: string;
  /** Override the `~/.config/nats` base (tests sandbox this). */
  natsDir?: string;
  /**
   * Override the `~/.config/metafactory/agents` sidecar base (tests sandbox this).
   * Mirrors the `MF_SIDECAR_DIR` contract.
   */
  sidecarDir?: string;
  /** Optional human-readable display name for templates (else derived from id). */
  displayName?: string;
  /** Optional principal id — logged for correlation only; NOT used for identity. */
  principal?: string;
  /** Suppress stdout action lines (non-interactive / test use). */
  quiet?: boolean;
}

export interface ProvisionIdentityResult {
  /**
   * True iff identity (NKey + DID) was wired and the provisioning sidecar was
   * written. Does NOT imply a state scaffold ran — a stateless agent (no
   * manifest `state`) provisions successfully with `provisioned: true` and
   * `stateScaffolded: false`.
   */
  provisioned: boolean;
  /** True iff the opt-in instance-state directory was scaffolded (arc#281). */
  stateScaffolded: boolean;
  agentId: string;
  did: string;
  /** Path the NKey seed lives at (canonical), whether created or reused. */
  nkeySeedPath: string;
  /** Best-effort U-prefixed public key; empty when derivation isn't available. */
  nkeyPub: string;
  /**
   * The instance-state directory. Populated only when `stateScaffolded` is true;
   * empty string for a stateless agent (no dir was created).
   */
  instanceDir: string;
  /** Path to the arc-owned provisioning sidecar JSON (the canonical record). */
  sidecarPath: string;
  /** Per-action log, in order. */
  actions: ProvisionAction[];
  /** Set when a fail-closed guard fired; carries operator guidance. */
  warning?: string;
}

/**
 * Provision an agent's identity (+ optionally its instance state) at install
 * time. Idempotent and fail-closed: safe to call on every install/upgrade.
 *
 * Flow (mirrors arc#228 §Specification step 3–4, revised for arc#281 opt-in state):
 *   1. Validate the agent id grammar (refuse rather than write a bad path).
 *   2. Fail-closed Rule 1 (arc#281 revision) — the arc-owned SIDECAR dir must
 *      exist or be creatable. cortex#563 analogue: don't wire identity without a
 *      place to anchor the provisioning record. That anchor USED to be the
 *      instance-state skeleton, but state is now opt-in (stateless agents have
 *      no instance dir), so identity anchors to the arc-owned sidecar dir
 *      instead — which arc always owns and creates for every agent. The guard
 *      fires only when creating the sidecar dir itself fails (e.g. EACCES).
 *   3. Generate the NKey seed if absent (self-contained codec), chmod 600.
 *      Idempotency Rule 2: an existing seed is reused, never regenerated.
 *   4. Best-effort derive the pubkey (empty is acceptable; cortex logs at boot).
 *   5. OPT-IN (arc#281): when `scaffoldState` is true, scaffold the instance-
 *      state layout (operator-edited files never clobbered) and record
 *      provisioning in `state.sqlite` metadata. Skipped entirely for stateless
 *      agents — no instance dir is created.
 *   6. Write the arc-owned provisioning sidecar (the CANONICAL record + the
 *      idempotency anchor) for ALL agents, stateful or stateless.
 */
export async function provisionAgentIdentity(
  opts: ProvisionIdentityOptions,
): Promise<ProvisionIdentityResult> {
  const { agentId } = opts;
  const did = agentDidFromId(agentId);
  const scaffoldState = opts.scaffoldState === true;
  const nkeySeedPath = nkeyPathForAgent(agentId, opts.natsDir);
  const sidecarPath = provisionSidecarPathForAgent(agentId, opts.sidecarDir);
  const actions: ProvisionAction[] = [];
  // instanceDir is only meaningful for stateful agents; empty otherwise so the
  // result never implies a dir was created when it wasn't.
  let instanceDir = "";

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
      stateScaffolded: false,
      agentId,
      did,
      nkeySeedPath,
      nkeyPub,
      instanceDir,
      sidecarPath,
      actions,
      warning,
    };
  };

  // 1. Grammar guard — never write a seed/state/sidecar path from a malformed id.
  if (!AGENT_ID_RE.test(agentId)) {
    return fail(
      `invalid agent id "${agentId}" — expected lowercase alphanumeric + single ` +
        `internal hyphens (no leading/trailing/double hyphens); skipping identity provisioning`,
    );
  }

  // 2. Fail-closed Rule 1 (arc#281 revision) — pre-flight EVERY directory we will
  //    write into BEFORE generating the seed. This restores main's ordering
  //    guarantee (cortex#563 orphan-prevention): no NKey seed lands on disk until
  //    we know every record we owe can be written. The anchor moved from the
  //    instance-state skeleton (now opt-in) to the arc-owned sidecar dir
  //    (`~/.config/metafactory/agents/`), which arc owns for EVERY agent; when
  //    the manifest opts into state, the instance dir is pre-flighted too, so a
  //    stateful agent whose instance dir is unwritable ALSO fails before the
  //    seed exists — never leaving a seed with no record anywhere.
  const sidecarDir = dirOf(sidecarPath);
  const sidecarGuard = ensureOwnerOnlyDir(
    sidecarDir,
    `cannot create agent provisioning dir at ${sidecarDir}`,
    "refusing to wire identity without a place to record it — set MF_SIDECAR_DIR " +
      "to a writable path or fix permissions, then re-run",
  );
  if (sidecarGuard) return fail(sidecarGuard);

  if (scaffoldState) {
    instanceDir = opts.instanceDir ?? instanceDirForAgent(agentId);
    const created = !existsSync(instanceDir);
    const instanceGuard = ensureOwnerOnlyDir(
      instanceDir,
      `cannot create agent instance dir at ${instanceDir}`,
      "the manifest declares 'state' but the scaffold could not be laid down — " +
        "set MF_INSTANCE_DIR to a writable path or fix permissions, then re-run",
    );
    if (instanceGuard) return fail(instanceGuard);
    if (created) record("created", "instance-dir");
  }

  // 3. NKey seed — generate if missing (idempotency Rule 2: reuse if present).
  //    Only reached once every target dir above is confirmed writable.
  if (existsSync(nkeySeedPath)) {
    // Defensively re-assert 0o600 on the upgrade path: a pre-existing seed that
    // was created (or copied) with looser perms must not silently stay
    // world/group-readable just because we're skipping generation. (Nit (3).)
    try {
      chmodSync(nkeySeedPath, 0o600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(
        `cannot re-assert 0o600 on the existing NKey seed at ${nkeySeedPath} (${msg}); ` +
          `fix ownership/permissions on the seed file, then re-run`,
      );
    }
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

  // 5. OPT-IN instance-state scaffold (arc#281). Only when the manifest declared
  //    `state`. Stateless agents skip this entirely — no instance dir is created.
  //    The dir was already pre-flighted in step 2, so this only lays down files.
  if (scaffoldState) {
    scaffoldInstanceState(instanceDir, agentId, opts.displayName ?? formatDisplayName(agentId), record);
    // Keep the state.sqlite metadata record for stateful agents (least churn —
    // downstream tooling that reads it keeps working). The sidecar (step 6) is
    // the canonical record; this is a redundant convenience copy.
    recordProvisioningMetadata(instanceDir, { did, nkeySeedPath, nkeyPub }, record);
  } else {
    record("skipped", "instance-state", "stateless (no manifest state)");
  }

  // 6. Write the arc-owned provisioning sidecar — CANONICAL record + idempotency
  //    anchor, for ALL agents (stateful or stateless). For a legacy pre-#281
  //    stateful agent re-installed WITHOUT a manifest `state` field, an existing
  //    instance dir on disk is reflected honestly (state_scaffolded from reality,
  //    not from the absent opt-in).
  const legacyInstanceDir =
    !scaffoldState ? existingLegacyInstanceDir(agentId, opts.instanceDir) : "";
  const sidecarErr = writeProvisionSidecar(
    sidecarPath,
    {
      agentId,
      did,
      nkeySeedPath,
      nkeyPub,
      stateScaffolded: scaffoldState || legacyInstanceDir !== "",
      instanceDir: scaffoldState ? instanceDir : legacyInstanceDir,
      legacy: !scaffoldState && legacyInstanceDir !== "",
    },
    record,
  );
  if (sidecarErr) {
    // The sidecar is the canonical record; if we cannot write it we have no
    // durable proof of provisioning. Fail closed with guidance rather than
    // returning success with an unrecorded provision.
    return fail(sidecarErr, nkeyPub);
  }

  return {
    provisioned: true,
    stateScaffolded: scaffoldState,
    agentId,
    did,
    nkeySeedPath,
    nkeyPub,
    instanceDir,
    sidecarPath,
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
  /**
   * Instance-state opt-in (arc#281). When present (with both subfields), the
   * agent gets an instance-state scaffold; when absent, the agent is stateless.
   * Only its PRESENCE gates the scaffold here — shape validation happens at
   * manifest load (`validateAgentState` in manifest.ts). Typed as possibly
   * `null` because a bare `state:` YAML key parses to null; the gate treats
   * null as "no opt-in" (`!= null`).
   */
  state?: { blueprint?: string; version?: string } | null;
}

/**
 * install.ts wiring hook — the SINGLE entry point install calls at the identity
 * step. No-op for non-agent packages. For `type: agent`, resolves the canonical
 * agent id and invokes {@link provisionAgentIdentity}.
 *
 * Opt-in state (arc#281): the instance-state scaffold runs ONLY when the
 * manifest declares `state`. Identity (NKey/DID) + the provisioning sidecar are
 * provisioned for every agent regardless.
 *
 * Environment contract (arc#228 §Environment contract, extended arc#281):
 *   - `MF_AGENT_ID`     overrides the manifest-derived agent id.
 *   - `MF_INSTANCE_DIR` overrides the default `~/.config/cortex/agents/<id>`
 *                       (only consulted when the manifest opts into state).
 *   - `MF_NATS_DIR`     overrides the default `~/.config/nats` seed base (lets
 *                       a host/test redirect NKey storage; production leaves it).
 *   - `MF_SIDECAR_DIR`  overrides the default `~/.config/metafactory/agents`
 *                       provisioning-sidecar base (tests redirect it).
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

  // Opt-in gate (arc#281): scaffold state only when the manifest declares it.
  // Presence gates here; the manifest loader (validateAgentState) has already
  // rejected a malformed shape (including a bare `state:` → null), so a present,
  // non-null `state` is a well-formed opt-in. Use `!= null` so a YAML null that
  // somehow reaches this path (e.g. a caller bypassing the loader) is treated as
  // "no opt-in" rather than opting an agent into an empty scaffold.
  const scaffoldState = manifest.state != null;

  return provisionAgentIdentity({
    agentId,
    scaffoldState,
    instanceDir: envOrUndefined("MF_INSTANCE_DIR"),
    natsDir: envOrUndefined("MF_NATS_DIR"),
    sidecarDir: envOrUndefined("MF_SIDECAR_DIR"),
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

/**
 * Write the arc-owned provisioning sidecar (arc#281, option (a)) — the CANONICAL
 * provisioning record for EVERY agent (stateful or not).
 *
 * A small JSON file at `~/.config/metafactory/agents/<id>.provision.json`, chmod
 * 600 (it names the nkey_seed_path + nkey_pub, same sensitivity as the
 * state.sqlite metadata it duplicates). Written on every run; `provisioned_at`
 * refreshes each time, so the file is NOT byte-stable across runs (only its
 * identity-bearing fields are stable). arc does not yet read the sidecar back —
 * it is a durable, human-inspectable record of what was provisioned; a future
 * idempotency check can key off it (it exists for stateless agents, which have
 * no state.sqlite).
 *
 * Fail-closed: returns a warning string on ANY IO error (ENOSPC, foreign-owned
 * file, …) instead of throwing, so the module's "never throws" contract holds
 * for both install.ts call sites. Returns null on success.
 */
function writeProvisionSidecar(
  sidecarPath: string,
  facts: {
    agentId: string;
    did: string;
    nkeySeedPath: string;
    nkeyPub: string;
    stateScaffolded: boolean;
    instanceDir: string;
    /** True when state_scaffolded reflects a pre-#281 dir found on disk, not a
     *  manifest opt-in this run — recorded so the file is self-describing. */
    legacy: boolean;
  },
  record: (kind: ProvisionAction["kind"], what: string, reason?: string) => void,
): string | null {
  const existed = existsSync(sidecarPath);
  const payload = {
    schema: "arc/provision/v1",
    agent_id: facts.agentId,
    did: facts.did,
    provisioned: true,
    provisioned_at: new Date().toISOString(),
    nkey_seed_path: facts.nkeySeedPath,
    // Omit an empty pubkey rather than record "" — matches the state.sqlite
    // metadata's "only write nkey_pub when derivable" posture.
    ...(facts.nkeyPub ? { nkey_pub: facts.nkeyPub } : {}),
    state_scaffolded: facts.stateScaffolded,
    ...(facts.stateScaffolded && facts.instanceDir ? { instance_dir: facts.instanceDir } : {}),
    // Mark a legacy reflection so a reader can tell "arc scaffolded this dir this
    // run" apart from "a pre-#281 dir was found already on disk".
    ...(facts.legacy ? { legacy_instance_state: true } : {}),
  };
  try {
    writeFileSync(sidecarPath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    chmodSync(sidecarPath, 0o600); // re-assert on the overwrite path (umask on existing file)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      `could not write the provisioning sidecar at ${sidecarPath} (${msg}); ` +
      `identity is wired but unrecorded — set MF_SIDECAR_DIR to a writable path or ` +
      `fix permissions/space, then re-run`
    );
  }
  // Overwrite of an existing sidecar refreshes provisioned_at, so it is an
  // update, not a skip — record it honestly.
  record(existed ? "updated" : "created", "provision-sidecar", existed ? "refreshed" : undefined);
  return null;
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

/**
 * Ensure `dir` exists and is owner-only (0o700), creating it if absent.
 *
 * Every filesystem op is wrapped: a missing dir is created; an existing dir has
 * its perms re-asserted. On ANY failure (EACCES, ENOSPC, foreign-owned dir …)
 * returns a composed warning string; on success returns null. The caller turns a
 * non-null return into a fail-closed result — this is what keeps the module's
 * documented "never throws" contract true for both install.ts call sites.
 */
function ensureOwnerOnlyDir(dir: string, whatFailed: string, guidance: string): string | null {
  try {
    if (!existsSync(dir)) {
      // 0o700: these dirs hold state.sqlite / the sidecar, which name the
      // nkey_seed_path + nkey_pub. Keep them owner-only (mirrors identity.ts's
      // ensureKeysDir) so sibling-readable defaults don't leak the seed location.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    chmodSync(dir, 0o700); // recursive:true only modes the leaf; be explicit + re-assert on the upgrade path
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${whatFailed} (${msg}); ${guidance}`;
  }
}

/**
 * For a STATELESS install (no manifest `state`), detect a pre-#281 instance-state
 * dir already on disk. A legacy stateful agent re-installed without the (new)
 * `state` field must not have its existing `state.sqlite` + dir misrepresented as
 * absent in the sidecar. Returns the dir path when it exists, else "".
 */
function existingLegacyInstanceDir(agentId: string, instanceDirOverride?: string): string {
  const dir = instanceDirOverride ?? instanceDirForAgent(agentId);
  return existsSync(dir) ? dir : "";
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
