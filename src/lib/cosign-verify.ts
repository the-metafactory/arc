/**
 * A-503: Client-side Sigstore/cosign verification.
 *
 * Companion to meta-factory's F-008/F-009/F-010. When a version has a
 * `signature_bundle_key` in its signing block, arc downloads the bundle from
 * the registry's bundle endpoint and hands it to cosign (via the bundled
 * binary wrapper) along with the expected signer identity and OIDC issuer.
 *
 * Scope (OQ-14): GitHub Actions OIDC only — other issuers are out of scope
 * for phase 1. Anonymous bundle fetch (DD-80): no Authorization header.
 */

import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import type { RegistrySource } from "../types.js";
import { verifySigstoreBundle, type VerifySigstoreResult } from "./cosign.js";

const FETCH_TIMEOUT_MS = 30_000;

/** OQ-14: phase 1 accepts only GitHub Actions OIDC as signer issuer. */
export const TRUSTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export interface VersionSigstoreSigning {
  signature_bundle_key: string | null;
  signer_identity: string | null;
}

export interface SigstoreVerifyResult {
  /** true = verified; false = verified-and-rejected; null = not-applicable (unsigned). */
  verified: boolean | null;
  reason: string;
}

export type SigstoreVerifier = (
  artifactPath: string,
  bundlePath: string,
  expectedIdentity: string,
  expectedIssuer: string,
) => Promise<VerifySigstoreResult>;

// ---------------------------------------------------------------------------
// Bundle download
// ---------------------------------------------------------------------------

/**
 * Download a Sigstore bundle to a temp file. Anonymous (no Authorization
 * header) per DD-80 — bundles are public, the registry route is unauth'd.
 * Never throws; returns `{error}` on any failure.
 */
export async function downloadSigstoreBundle(
  url: string,
  tempDir: string,
): Promise<{ path?: string; error?: string }> {
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { error: `bundle not found or unreachable (HTTP ${resp.status})` };
    }
    const body = await resp.text();
    const path = join(tempDir, `arc-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bundle`);
    await writeFile(path, body);
    return { path };
  } catch (err: any) {
    return { error: `bundle download failed: ${err?.message ?? err}` };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface VerifyPackageSigstoreOptions {
  source: RegistrySource;
  sha256: string;
  signing: VersionSigstoreSigning;
  artifactPath: string;
  tempDir: string;
  /** Injectable for tests; defaults to the bundled-cosign wrapper. */
  verifier?: SigstoreVerifier;
}

export async function verifyPackageSigstore(
  opts: VerifyPackageSigstoreOptions,
): Promise<SigstoreVerifyResult> {
  const { source, sha256, signing, artifactPath, tempDir } = opts;
  const verifier: SigstoreVerifier = opts.verifier ?? verifySigstoreBundle;

  if (!signing.signature_bundle_key) {
    return { verified: null, reason: "version is not sigstore-signed (legacy or unsigned publish)" };
  }

  if (!signing.signer_identity) {
    return {
      verified: false,
      reason: "signer_identity missing — cannot verify Sigstore bundle without expected identity",
    };
  }

  const bundleUrl = `${source.url}/api/v1/storage/bundle/${sha256}`;
  const dl = await downloadSigstoreBundle(bundleUrl, tempDir);
  if (!dl.path) {
    return { verified: false, reason: `bundle ${dl.error ?? "download failed"}` };
  }

  try {
    const result = await verifier(artifactPath, dl.path, signing.signer_identity, TRUSTED_OIDC_ISSUER);
    if (result.valid) {
      return { verified: true, reason: `Sigstore bundle verified for ${signing.signer_identity}` };
    }
    return { verified: false, reason: result.error ?? "cosign verification failed" };
  } finally {
    await unlink(dl.path).catch(() => {});
  }
}
