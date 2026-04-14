/**
 * A-504: Client-side verification of registry-level Ed25519 signatures.
 *
 * Companion to meta-factory's F-501. The registry signs the exact manifest
 * bytes stored in D1 at publish time; arc fetches the same bytes (via the
 * `manifest_canonical` field on the version-detail endpoint) and verifies
 * them against the `registry_signature` bound to the version using the
 * public key served at `/.well-known/metafactory-signing-key`.
 *
 * Uses Bun's Web Crypto (Ed25519 support landed in 1.0+). No external deps.
 */

import type { RegistrySource } from "../types.js";

const WELL_KNOWN_PATH = "/.well-known/metafactory-signing-key";
const FETCH_TIMEOUT_MS = 10_000;

export interface RegistryPublicKey {
  algorithm: "Ed25519";
  key_id: string;
  public_key: string; // base64 raw 32-byte Ed25519 public key
  created_at: number;
}

export interface VersionSigning {
  registry_signature: string | null;
  registry_key_id: string | null;
}

export interface SignatureVerifyResult {
  /** true = verified; false = verified-and-rejected; null = not-applicable (unsigned). */
  verified: boolean | null;
  /** Short human-readable reason, suitable for stderr. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Public-key fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the registry's signing public key. Returns null if the registry has
 * not configured a key (503) or is unreachable. Anonymous — no auth header.
 */
export async function fetchRegistryPublicKey(
  source: RegistrySource,
): Promise<RegistryPublicKey | null> {
  const url = `${source.url}${WELL_KNOWN_PATH}`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.status === 503) return null;
    if (!resp.ok) return null;
    const body = (await resp.json()) as Partial<RegistryPublicKey>;
    if (
      body.algorithm !== "Ed25519" ||
      typeof body.key_id !== "string" ||
      typeof body.public_key !== "string"
    ) {
      return null;
    }
    return body as RegistryPublicKey;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Verify an Ed25519 registry signature against the exact manifest bytes.
 * Returns false on any malformed input, wrong-length key/sig, or crypto
 * error — never throws. Constant-time via crypto.subtle.verify (no `===`
 * on bytes).
 */
export async function verifyRegistrySignature(
  publicKeyBase64: string,
  signatureBase64: string,
  manifestCanonical: string,
): Promise<boolean> {
  try {
    const pubBytes = base64ToBytes(publicKeyBase64);
    const sigBytes = base64ToBytes(signatureBase64);
    if (pubBytes.length !== 32) return false;
    if (sigBytes.length !== 64) return false;

    // Copy into fresh ArrayBuffers — lib.dom's BufferSource rejects the
    // ArrayBufferLike union even though the runtime accepts it.
    const pubBuf = pubBytes.buffer.slice(pubBytes.byteOffset, pubBytes.byteOffset + pubBytes.byteLength) as ArrayBuffer;
    const sigBuf = sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer;
    const msgBytes = new TextEncoder().encode(manifestCanonical);
    const msgBuf = msgBytes.buffer.slice(msgBytes.byteOffset, msgBytes.byteOffset + msgBytes.byteLength) as ArrayBuffer;

    const key = await crypto.subtle.importKey(
      "raw",
      pubBuf,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBuf, msgBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestration — fetch key + verify, wrap in a human-readable result
// ---------------------------------------------------------------------------

export async function verifyVersionSignature(
  source: RegistrySource,
  signing: VersionSigning,
  manifestCanonical: string | null | undefined,
): Promise<SignatureVerifyResult> {
  // Legacy / unsigned row: nothing to verify. The registry either predates
  // F-501 or was in degraded mode when this version was published. Caller
  // decides whether to warn or proceed.
  if (!signing.registry_signature || !signing.registry_key_id) {
    return { verified: null, reason: "version is unsigned (legacy or degraded publish)" };
  }

  if (!manifestCanonical) {
    return {
      verified: false,
      reason: "manifest_canonical missing from registry response — cannot verify signature",
    };
  }

  const key = await fetchRegistryPublicKey(source);
  if (!key) {
    return {
      verified: false,
      reason: `registry public key unavailable at ${source.url}${WELL_KNOWN_PATH}`,
    };
  }

  if (key.key_id !== signing.registry_key_id) {
    return {
      verified: false,
      reason: `key_id mismatch — version was signed with ${signing.registry_key_id}, registry currently serves ${key.key_id}`,
    };
  }

  const ok = await verifyRegistrySignature(
    key.public_key,
    signing.registry_signature,
    manifestCanonical,
  );
  return ok
    ? { verified: true, reason: `verified with ${key.key_id}` }
    : { verified: false, reason: "Ed25519 signature does not match manifest bytes" };
}
