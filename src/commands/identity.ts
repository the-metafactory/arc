/**
 * arc identity — Myelin signing identity management.
 *
 * Generates Ed25519 keypairs for bot signing and manages the
 * PrincipalRegistry (principals.json) file. Part of grove#320 AAA.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../lib/user-home.js";
import { getPublicKeyAsync } from "@noble/ed25519";
import { randomBytes } from "node:crypto";
import { AGENT_ID_RE as NAMING_RE, formatDisplayName } from "../lib/agent-naming.js";

/**
 * The identity keystore base, resolved AT CALL TIME (arc#421 round 2).
 *
 * These three were module-load `const`s. `METAFACTORY_CONFIG_DIR` was
 * therefore read ONCE, before any test could set it — which is exactly what
 * `test/commands/identity.test.ts` tries to do in its `beforeAll`. The
 * override silently did nothing and `bun test` wrote `keys/` and
 * `principals.json` entries into the operator's REAL `~/.config/metafactory`.
 * Resolving per call makes the documented `METAFACTORY_CONFIG_DIR` contract
 * (see `src/lib/paths.ts`) actually hold.
 */
function configBase(): string {
  return process.env.METAFACTORY_CONFIG_DIR ?? join(userHome(), ".config", "metafactory");
}
function keysDir(): string {
  return join(configBase(), "keys");
}
function registryPath(): string {
  return join(configBase(), "principals.json");
}
const DID_RE = /^did:mf:[a-z][a-z0-9._-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

export interface Principal {
  id: string;
  display_name?: string;
  operator: string;
  public_key: string;
  type: "agent" | "service" | "operator";
  created_at: string;
  is_hub?: boolean;
}

export interface PrincipalRegistryFile {
  version: 1;
  principals: Principal[];
  trusted_hubs: string[];
}

function ensureKeysDir(): void {
  if (!existsSync(keysDir())) {
    mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  }
  chmodSync(keysDir(), 0o700);
}

function keyPath(name: string): string {
  return join(keysDir(), `${name}.key`);
}

function validatePrincipal(p: unknown, index: number): asserts p is Principal {
  if (!p || typeof p !== "object") throw new Error(`principals[${index}]: not an object`);
  const r = p as Record<string, unknown>;
  if (typeof r.id !== "string" || !DID_RE.test(r.id)) throw new Error(`principals[${index}].id: invalid DID "${String(r.id)}"`);
  if (typeof r.public_key !== "string" || !BASE64_RE.test(r.public_key) || r.public_key.length < 40) {
    throw new Error(`principals[${index}].public_key: invalid (must be base64, ≥40 chars)`);
  }
  if (typeof r.operator !== "string" || r.operator.length === 0) throw new Error(`principals[${index}].operator: required`);
  if (!["agent", "service", "operator"].includes(r.type as string)) throw new Error(`principals[${index}].type: must be agent/service/operator`);
}

function loadRegistry(): PrincipalRegistryFile {
  if (!existsSync(registryPath())) {
    return { version: 1, principals: [], trusted_hubs: [] };
  }
  const raw = JSON.parse(readFileSync(registryPath(), "utf-8")) as Partial<PrincipalRegistryFile>;
  if (raw.version !== 1 || !Array.isArray(raw.principals)) {
    throw new Error(`Invalid registry at ${registryPath()}: expected version 1 with principals array`);
  }
  return raw as PrincipalRegistryFile;
}

function saveRegistry(registry: PrincipalRegistryFile): void {
  if (!existsSync(configBase())) {
    mkdirSync(configBase(), { recursive: true });
  }
  writeFileSync(registryPath(), JSON.stringify(registry, null, 2) + "\n");
  console.log(`  registry: ${registryPath()}`);
}

export async function generateIdentity(
  name: string,
  operator: string,
  opts: { force?: boolean } = {},
): Promise<{ publicKeyB64: string; did: string }> {
  if (!NAMING_RE.test(name)) {
    throw new Error(`Invalid bot name: "${name}" — lowercase alphanumeric + hyphens, no trailing/consecutive hyphens`);
  }

  ensureKeysDir();
  const kp = keyPath(name);

  if (existsSync(kp) && !opts.force) {
    throw new Error(`Signing key already exists at ${kp}. Use --force to overwrite.`);
  }

  // Set restrictive umask before writing private key
  const prevUmask = process.umask(0o077);
  try {
    const privateKeyBytes = randomBytes(32);
    const publicKeyBytes = await getPublicKeyAsync(privateKeyBytes);

    const privateKeyB64 = Buffer.from(privateKeyBytes).toString("base64");
    const publicKeyB64 = Buffer.from(publicKeyBytes).toString("base64");

    writeFileSync(kp, privateKeyB64, { mode: 0o600 });

    const did = `did:mf:${name}`;

    const registry = loadRegistry();
    const existing = registry.principals.findIndex((p) => p.id === did);
    const principal: Principal = {
      id: did,
      display_name: formatDisplayName(name),
      operator,
      public_key: publicKeyB64,
      type: "agent",
      created_at: new Date().toISOString(),
    };

    if (existing >= 0) {
      registry.principals[existing] = principal;
      console.log(`  updated principal: ${did}`);
    } else {
      registry.principals.push(principal);
      console.log(`  added principal: ${did}`);
    }
    saveRegistry(registry);

    console.log(`  signing key: ${kp} (mode 600)`);
    console.log(`  public key: ${publicKeyB64}`);

    return { publicKeyB64, did };
  } finally {
    process.umask(prevUmask);
  }
}

export function exportPrincipals(operator?: string): void {
  const registry = loadRegistry();

  // Default: export only principals that were locally generated (have a key file)
  // With -a: filter to that operator
  let principals = registry.principals;
  if (operator) {
    principals = principals.filter((p) => p.operator === operator);
  } else {
    principals = principals.filter((p) => {
      const name = p.id.replace(/^did:mf:/, "");
      return existsSync(keyPath(name));
    });
  }

  if (principals.length === 0) {
    console.error(operator
      ? `No principals found for operator "${operator}"`
      : "No locally-generated principals found (no matching key files)");
    process.exitCode = 1;
    return;
  }

  const exportData: PrincipalRegistryFile = {
    version: 1,
    principals,
    trusted_hubs: [],
  };

  process.stdout.write(JSON.stringify(exportData, null, 2) + "\n");
}

export function importPrincipals(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  let incoming: PrincipalRegistryFile;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<PrincipalRegistryFile>;
    if (raw.version !== 1 || !Array.isArray(raw.principals)) {
      throw new Error("expected { version: 1, principals: [...] }");
    }
    for (let i = 0; i < raw.principals.length; i++) {
      validatePrincipal(raw.principals[i], i);
    }
    incoming = raw as PrincipalRegistryFile;
  } catch (err) {
    console.error(`Invalid principals file: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (incoming.trusted_hubs.length > 0) {
    console.log(`  NOTE: trusted_hubs in import file ignored (security boundary — add manually if needed)`);
  }

  const registry = loadRegistry();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let rejected = 0;

  for (const incoming_p of incoming.principals) {
    const existing = registry.principals.findIndex((p) => p.id === incoming_p.id);
    if (existing >= 0) {
      const old = registry.principals[existing];
      if (old.public_key === incoming_p.public_key) {
        skipped++;
        continue;
      }
      // Key conflict: check operator consistency
      if (old.operator !== incoming_p.operator) {
        console.error(`  REJECTED: ${incoming_p.id} — operator mismatch (local: ${old.operator}, import: ${incoming_p.operator}). Manual resolution required.`);
        rejected++;
        continue;
      }
      console.log(`  UPDATED: ${incoming_p.id} (key rotated, same operator ${old.operator})`);
      registry.principals[existing] = incoming_p;
      updated++;
    } else {
      console.log(`  added: ${incoming_p.id} (operator: ${incoming_p.operator})`);
      registry.principals.push(incoming_p);
      added++;
    }
  }

  saveRegistry(registry);
  console.log(`Import complete: ${added} added, ${updated} updated, ${skipped} unchanged, ${rejected} rejected`);
}

export function listPrincipals(): void {
  const registry = loadRegistry();
  if (registry.principals.length === 0) {
    console.log("No principals registered.");
    console.log(`Registry: ${registryPath()}`);
    return;
  }

  console.log(`Principals (${registry.principals.length}):\n`);
  for (const p of registry.principals) {
    const hasKey = existsSync(keyPath(p.id.replace(/^did:mf:/, "")));
    console.log(`  ${p.id}${hasKey ? " (local)" : ""}`);
    console.log(`    operator: ${p.operator}`);
    console.log(`    type: ${p.type}`);
    console.log(`    key: ${p.public_key.slice(0, 16)}...`);
    console.log(`    created: ${p.created_at}`);
    console.log();
  }
  console.log(`Registry: ${registryPath()}`);
}
