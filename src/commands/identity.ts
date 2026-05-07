/**
 * arc identity — Myelin signing identity management.
 *
 * Generates Ed25519 keypairs for bot signing and manages the
 * PrincipalRegistry (principals.json) file. Part of grove#320 AAA.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getPublicKeyAsync } from "@noble/ed25519";
import { randomBytes } from "node:crypto";

const CONFIG_BASE = process.env.METAFACTORY_CONFIG_DIR ?? join(homedir(), ".config", "metafactory");
const KEYS_DIR = join(CONFIG_BASE, "keys");
const REGISTRY_PATH = join(CONFIG_BASE, "principals.json");
const DID_RE = /^did:mf:[a-z][a-z0-9._-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
const NAMING_RE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

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
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }
  chmodSync(KEYS_DIR, 0o700);
}

function keyPath(name: string): string {
  return join(KEYS_DIR, `${name}.key`);
}

function validatePrincipal(p: unknown, index: number): asserts p is Principal {
  if (!p || typeof p !== "object") throw new Error(`principals[${index}]: not an object`);
  const r = p as Record<string, unknown>;
  if (typeof r.id !== "string" || !DID_RE.test(r.id)) throw new Error(`principals[${index}].id: invalid DID "${r.id}"`);
  if (typeof r.public_key !== "string" || !BASE64_RE.test(r.public_key) || r.public_key.length < 40) {
    throw new Error(`principals[${index}].public_key: invalid (must be base64, ≥40 chars)`);
  }
  if (typeof r.operator !== "string" || r.operator.length === 0) throw new Error(`principals[${index}].operator: required`);
  if (!["agent", "service", "operator"].includes(r.type as string)) throw new Error(`principals[${index}].type: must be agent/service/operator`);
}

function loadRegistry(): PrincipalRegistryFile {
  if (!existsSync(REGISTRY_PATH)) {
    return { version: 1, principals: [], trusted_hubs: [] };
  }
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  if (raw.version !== 1 || !Array.isArray(raw.principals)) {
    throw new Error(`Invalid registry at ${REGISTRY_PATH}: expected version 1 with principals array`);
  }
  return raw as PrincipalRegistryFile;
}

function saveRegistry(registry: PrincipalRegistryFile): void {
  if (!existsSync(CONFIG_BASE)) {
    mkdirSync(CONFIG_BASE, { recursive: true });
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(`  registry: ${REGISTRY_PATH}`);
}

function formatDisplayName(name: string): string {
  return name.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (raw.version !== 1 || !Array.isArray(raw.principals)) {
      throw new Error("expected { version: 1, principals: [...] }");
    }
    for (let i = 0; i < raw.principals.length; i++) {
      validatePrincipal(raw.principals[i], i);
    }
    incoming = raw;
  } catch (err) {
    console.error(`Invalid principals file: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (incoming.trusted_hubs?.length > 0) {
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
    console.log(`Registry: ${REGISTRY_PATH}`);
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
  console.log(`Registry: ${REGISTRY_PATH}`);
}
