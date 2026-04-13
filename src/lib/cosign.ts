/**
 * Thin wrapper around the bundled cosign binary.
 * Locates the correct platform binary and shells out for verification.
 * Auto-fetches the binary on first use if not present.
 */

import { join } from "path";
import { existsSync } from "fs";
import { writeFile, mkdir, chmod } from "fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COSIGN_VERSION = "v3.0.6";
const CHECKSUMS_URL = `https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign_checksums.txt`;

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

interface PlatformInfo {
  os: string;
  arch: string;
  binaryName: string;
  downloadUrl: string;
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
  const binaryName = `cosign-${os}-${arch}`;
  const downloadUrl = `https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${binaryName}`;
  return { os, arch, binaryName, downloadUrl };
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function vendorDir(): string {
  return join(import.meta.dir, "..", "..", "vendor", "cosign");
}

/**
 * Locate the bundled cosign binary for the current platform.
 * Looks in vendor/cosign/ relative to the arc package root.
 */
export function findCosignBinary(): string | null {
  const platform = detectPlatform();
  const vendorPath = join(vendorDir(), platform.binaryName);
  if (existsSync(vendorPath)) return vendorPath;
  return null;
}

// ---------------------------------------------------------------------------
// Lazy fetch
// ---------------------------------------------------------------------------

/**
 * Download and verify the cosign binary for the current platform.
 * Only fetches the single binary needed — not all platforms.
 * Returns the path to the downloaded binary, or an error string.
 */
export async function fetchCosignBinary(): Promise<{ path?: string; error?: string }> {
  const platform = detectPlatform();
  const destDir = vendorDir();
  const destPath = join(destDir, platform.binaryName);

  // Already present
  if (existsSync(destPath)) return { path: destPath };

  process.stderr.write(`Downloading cosign ${COSIGN_VERSION} (${platform.binaryName})...\n`);

  try {
    // Fetch checksums
    const checksumResp = await fetch(CHECKSUMS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!checksumResp.ok) {
      return { error: `Failed to fetch cosign checksums: ${checksumResp.status}` };
    }
    const checksumText = await checksumResp.text();
    let expectedHash: string | undefined;
    for (const line of checksumText.split("\n")) {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
      if (match && match[2].trim() === platform.binaryName) {
        expectedHash = match[1];
        break;
      }
    }

    // Download binary
    const response = await fetch(platform.downloadUrl, {
      signal: AbortSignal.timeout(120_000),
      redirect: "follow",
    });
    if (!response.ok) {
      return { error: `Failed to download cosign: ${response.status} ${response.statusText}` };
    }

    const buffer = await response.arrayBuffer();

    // Verify checksum
    if (expectedHash) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(buffer);
      const actualHash = hasher.digest("hex");
      if (actualHash !== expectedHash) {
        return { error: `cosign checksum mismatch: expected ${expectedHash}, got ${actualHash}` };
      }
    }

    // Write binary
    if (!existsSync(destDir)) {
      await mkdir(destDir, { recursive: true });
    }
    await writeFile(destPath, Buffer.from(buffer));
    await chmod(destPath, 0o755);

    process.stderr.write(`cosign ${COSIGN_VERSION} downloaded and verified.\n`);
    return { path: destPath };
  } catch (err: any) {
    return { error: `Failed to fetch cosign: ${err.message ?? err}` };
  }
}

/**
 * Get cosign binary path, auto-fetching if not present.
 */
export async function ensureCosignBinary(): Promise<{ path?: string; error?: string }> {
  const existing = findCosignBinary();
  if (existing) return { path: existing };
  return fetchCosignBinary();
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
 * Auto-fetches cosign if not already present.
 *
 * @param artifactPath - Path to the artifact file (e.g., downloaded tarball)
 * @param bundlePath - Path to the Sigstore bundle (.sigstore.json)
 * @param expectedIdentity - Expected OIDC identity (e.g., GitHub Actions workflow URI)
 * @param expectedIssuer - Expected OIDC issuer (e.g., https://token.actions.githubusercontent.com)
 */
export async function verifySigstoreBundle(
  artifactPath: string,
  bundlePath: string,
  expectedIdentity: string,
  expectedIssuer: string,
): Promise<VerifySigstoreResult> {
  const cosign = await ensureCosignBinary();
  if (!cosign.path) {
    return { valid: false, error: cosign.error ?? "cosign binary unavailable" };
  }

  const result = Bun.spawnSync(
    [
      cosign.path,
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
