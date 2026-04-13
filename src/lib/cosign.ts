/**
 * Thin wrapper around the bundled cosign binary.
 * Locates the correct platform binary and shells out for verification.
 */

import { join } from "path";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

interface PlatformInfo {
  os: string;
  arch: string;
  binaryName: string;
}

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SUPPORTED_ARCHES = new Set(["arm64", "x64"]);

export function detectPlatform(): PlatformInfo {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}. cosign binaries are available for: ${[...SUPPORTED_PLATFORMS].join(", ")}`);
  }
  if (!SUPPORTED_ARCHES.has(process.arch)) {
    throw new Error(`Unsupported architecture: ${process.arch}. cosign binaries are available for: arm64, x64 (amd64)`);
  }
  const os = process.platform as string;
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return { os, arch, binaryName: `cosign-${os}-${arch}` };
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Locate the bundled cosign binary for the current platform.
 * Looks in vendor/cosign/ relative to the arc package root.
 */
export function findCosignBinary(): string | null {
  const platform = detectPlatform();

  // Resolve from arc's package root (two levels up from src/lib/)
  const vendorPath = join(import.meta.dir, "..", "..", "vendor", "cosign", platform.binaryName);
  if (existsSync(vendorPath)) return vendorPath;

  return null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifySigstoreResult {
  valid: boolean;
  error?: string;
  output?: string;
}

/**
 * Verify a Sigstore bundle for an artifact using cosign verify-blob.
 *
 * @param artifactPath - Path to the artifact file (e.g., downloaded tarball)
 * @param bundlePath - Path to the Sigstore bundle (.sigstore.json)
 * @param expectedIdentity - Expected OIDC identity (e.g., GitHub Actions workflow URI)
 * @param expectedIssuer - Expected OIDC issuer (e.g., https://token.actions.githubusercontent.com)
 */
export function verifySigstoreBundle(
  artifactPath: string,
  bundlePath: string,
  expectedIdentity: string,
  expectedIssuer: string,
): VerifySigstoreResult {
  const cosignPath = findCosignBinary();
  if (!cosignPath) {
    return {
      valid: false,
      error: `cosign binary not found for ${detectPlatform().binaryName}. Run: bun scripts/fetch-cosign.ts`,
    };
  }

  const result = Bun.spawnSync(
    [
      cosignPath,
      "verify-blob",
      "--bundle", bundlePath,
      "--certificate-identity", expectedIdentity,
      "--certificate-oidc-issuer", expectedIssuer,
      artifactPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  if (result.exitCode === 0) {
    return { valid: true, output: stdout || stderr };
  }

  return {
    valid: false,
    error: stderr || stdout || `cosign exited with code ${result.exitCode}`,
    output: stdout,
  };
}
