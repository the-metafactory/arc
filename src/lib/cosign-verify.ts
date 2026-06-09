/**
 * A-503: Client-side Sigstore/cosign verification.
 *
 * Companion to meta-factory's F-008/F-009/F-010. When a version has a
 * `signature_bundle_key` in its signing block, arc downloads the bundle from
 * the registry's bundle endpoint and hands it to cosign (via the bundled
 * binary wrapper) along with the expected signer identity and OIDC issuer.
 *
 * Scope (OQ-14): GitHub Actions OIDC only — other issuers are out of scope
 * for phase 1. Bundle fetch carries the source's bearer token when present
 * (#207 — the registry route is requireAuth()'d like the tarball download).
 */

import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import type { RegistrySource } from "../types.js";
import { errorMessage } from "./errors.js";
import { verifySigstoreBundle, type VerifySigstoreResult } from "./cosign.js";

const FETCH_TIMEOUT_MS = 30_000;

/** OQ-14: phase 1 accepts only GitHub Actions OIDC as signer issuer. */
export const TRUSTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export interface VersionSigstoreSigning {
  signature_bundle_key: string | null;
  signer_identity: string | null;
}

export interface SigstoreVerifyResult {
  /** true = verified; false = verified-and-rejected; null = unverifiable (unsigned, or signed but registry served no identity). */
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
 * Download a Sigstore bundle to a temp file.
 *
 * arc#207: the registry's `GET /storage/bundle/:sha256` is `requireAuth()`'d
 * ("same access level as tarball download" — meta-factory routes/storage.ts),
 * so a metafactory source's bearer token is attached exactly like
 * `downloadPackage` does for the tarball. The old anonymous-per-DD-80
 * behavior 401'd every signed install once the identity gap (#303) was
 * fixed and this download became reachable. Sources without a token stay
 * anonymous so public installs keep working if the route ever opens up.
 *
 * Never throws; returns `{error}` on any failure.
 */
export async function downloadSigstoreBundle(
  url: string,
  tempDir: string,
  source?: RegistrySource,
): Promise<{ path?: string; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (source?.token) {
      headers.Authorization = `Bearer ${source.token}`;
    }
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // The bundle route serves same-origin from the registry worker; no
      // redirect to third-party storage exists today. `manual` fail-closes
      // if that ever changes, instead of silently forwarding the bearer
      // cross-origin (same concern downloadPackage handles for tarballs).
      redirect: "manual",
    });
    if (!resp.ok) {
      return { error: `bundle not found or unreachable (HTTP ${resp.status})` };
    }
    const body = await resp.text();
    const path = join(tempDir, `arc-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bundle`);
    await writeFile(path, body);
    return { path };
  } catch (err) {
    return { error: `bundle download failed: ${errorMessage(err)}` };
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

  // soma#303: a bundle without a registry-served signer_identity is a
  // registry DATA gap (the bundle exists; only the expected-identity record
  // is missing), not evidence of tampering. Hard-failing here bricked every
  // signed install when the registry never populated the field (the
  // meta-factory#523 extraction bug). Two recovery paths:
  //   1. ARC_SIGSTORE_EXPECTED_IDENTITY — operator supplies the identity;
  //      full cosign verification runs against it.
  //   2. Otherwise degrade to verified=null: callers treat it like the
  //      unsigned case (prominent warning on official tier, and
  //      --strict-signing still turns it into a refusal).
  const operatorIdentity = process.env.ARC_SIGSTORE_EXPECTED_IDENTITY;
  const expectedIdentity = signing.signer_identity ?? operatorIdentity ?? null;
  const identitySource = signing.signer_identity ? "registry" : "operator-supplied";

  if (!expectedIdentity) {
    return {
      verified: null,
      reason:
        "bundle present but registry served no signer_identity — cannot verify; " +
        "set ARC_SIGSTORE_EXPECTED_IDENTITY=<workflow identity> to verify against a known identity",
    };
  }

  const bundleUrl = `${source.url}/api/v1/storage/bundle/${sha256}`;
  const dl = await downloadSigstoreBundle(bundleUrl, tempDir, source);
  if (!dl.path) {
    return { verified: false, reason: `bundle ${dl.error ?? "download failed"}` };
  }

  try {
    const result = await verifier(artifactPath, dl.path, expectedIdentity, TRUSTED_OIDC_ISSUER);
    if (result.valid) {
      return {
        verified: true,
        reason: `Sigstore bundle verified for ${expectedIdentity} (${identitySource} identity)`,
      };
    }
    return { verified: false, reason: result.error ?? "cosign verification failed" };
  } catch (err) {
    // Deliberate resilience policy (#216): a package manager must never abort
    // the whole install because the signature verifier could not *run*. A
    // throw out of the verifier means verification was unable to execute — a
    // *capability* gap, not evidence of tampering. The canonical case is
    // cosign having no binary for this platform/arch, so detectPlatform throws.
    //
    // This is safe BECAUSE failures that genuinely ran-and-rejected never
    // reach here: a ran-and-rejected cosign verify-blob returns valid:false
    // (→ verified:false above); the bundle download fails outside this try
    // (line 139 → verified:false); and the bundled-cosign wrapper reports
    // binary-fetch / checksum-mismatch failures as a returned {valid:false},
    // not a throw. So a throw is specifically "we couldn't perform the check".
    //
    // Degrade to verified=null — the same contract as unsigned and the
    // soma#303 missing-identity case: warn and proceed on the default path,
    // while --strict-signing still escalates null to a hard refusal, so the
    // security posture is preserved.
    return {
      verified: null,
      reason: `Sigstore verification unavailable: ${errorMessage(err)}`,
    };
  } finally {
    await unlink(dl.path).catch(() => {
      // best-effort cleanup
    });
  }
}
