/**
 * Thin wrapper around the bundled cosign binary.
 * Locates the correct platform binary and shells out for verification.
 * Auto-fetches the binary on first use if not present.
 */

import { join } from "path";
import { existsSync } from "fs";
import { writeFile, mkdir, chmod, rm } from "fs/promises";
import { tmpdir } from "os";
import { errorMessage } from "./errors.js";

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

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHES = new Set(["arm64", "x64"]);

// Node's process.platform value -> the os token sigstore/cosign uses in its
// release asset names. win32 maps to "windows" (cosign ships
// cosign-windows-amd64.exe / cosign-windows-arm64.exe).
const COSIGN_OS_NAME: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const SUPPORTED_PLATFORM_LABELS = [...SUPPORTED_PLATFORMS]
  .map((p) => COSIGN_OS_NAME[p] ?? p)
  .join(", ");

export function detectPlatform(
  platform: string = process.platform,
  architecture: string = process.arch,
): PlatformInfo {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported platform: ${platform}. cosign binaries are available for: ${SUPPORTED_PLATFORM_LABELS}`);
  }
  if (!SUPPORTED_ARCHES.has(architecture)) {
    throw new Error(`Unsupported architecture: ${architecture}. cosign binaries are available for: arm64, x64 (amd64)`);
  }
  const os = COSIGN_OS_NAME[platform];
  const arch = architecture === "arm64" ? "arm64" : "amd64";
  // cosign Windows assets carry a .exe suffix; unix binaries do not.
  const ext = platform === "win32" ? ".exe" : "";
  const binaryName = `cosign-${os}-${arch}${ext}`;
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
      const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
      if (match?.[2].trim() === platform.binaryName) {
        expectedHash = match[1];
        break;
      }
    }

    // Fail before downloading if no checksum available
    if (!expectedHash) {
      return { error: `No checksum found for ${platform.binaryName} in cosign checksums — refusing to install unverified binary` };
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
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(buffer);
    const actualHash = hasher.digest("hex");
    if (actualHash !== expectedHash) {
      return { error: `cosign checksum mismatch: expected ${expectedHash}, got ${actualHash}` };
    }

    // Write binary
    if (!existsSync(destDir)) {
      await mkdir(destDir, { recursive: true });
    }
    await writeFile(destPath, Buffer.from(buffer));
    // Make the binary executable on unix. On Windows fs.chmod is a harmless
    // no-op (NTFS has no POSIX permission bits), and the .exe extension is
    // what makes the file runnable there — so this needs no platform guard.
    await chmod(destPath, 0o755);

    process.stderr.write(`cosign ${COSIGN_VERSION} downloaded and verified.\n`);
    return { path: destPath };
  } catch (err) {
    return { error: `Failed to fetch cosign: ${errorMessage(err)}` };
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

export interface SignSigstoreResult {
  success: boolean;
  bundlePath?: string;
  signerIdentity?: string;
  signedAt?: number;
  error?: string;
  output?: string;
}

export function resolveSignerIdentity(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.ARC_SIGSTORE_SIGNER_IDENTITY) return env.ARC_SIGSTORE_SIGNER_IDENTITY;
  if (env.GITHUB_WORKFLOW_REF) return `https://github.com/${env.GITHUB_WORKFLOW_REF}`;
  return undefined;
}

type SigningAuth =
  | { kind: "github-actions"; signerIdentity?: string }
  | { kind: "identity-token"; token: string; signerIdentity?: string }
  | { kind: "identity-token-file"; tokenFile: string; signerIdentity?: string }
  | { kind: "unsupported"; error: string };

export function resolveSigningAuth(env: Record<string, string | undefined> = process.env): SigningAuth {
  const signerIdentity = resolveSignerIdentity(env);
  if (env.ARC_SIGSTORE_IDENTITY_TOKEN_FILE) {
    return { kind: "identity-token-file", tokenFile: env.ARC_SIGSTORE_IDENTITY_TOKEN_FILE, signerIdentity };
  }
  if (env.ARC_SIGSTORE_IDENTITY_TOKEN) {
    return { kind: "identity-token", token: env.ARC_SIGSTORE_IDENTITY_TOKEN, signerIdentity };
  }

  const hasGitHubActionsOidc =
    env.GITHUB_ACTIONS === "true"
    && Boolean(env.GITHUB_WORKFLOW_REF)
    && Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    && Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL);

  if (hasGitHubActionsOidc) {
    return { kind: "github-actions", signerIdentity };
  }

  return {
    kind: "unsupported",
    error: [
      "Sigstore signing requires GitHub Actions OIDC",
      "(workflow permissions: id-token: write, contents: read)",
      "or ARC_SIGSTORE_IDENTITY_TOKEN_FILE / ARC_SIGSTORE_IDENTITY_TOKEN.",
      "Local cosign browser/device auth is disabled because phase 1 install verification trusts GitHub Actions OIDC.",
    ].join(" "),
  };
}

/**
 * Sign an artifact with keyless cosign and write the Sigstore bundle to disk.
 */
export async function signSigstoreBundle(
  artifactPath: string,
  bundlePath: string,
): Promise<SignSigstoreResult> {
  const auth = resolveSigningAuth();
  if (auth.kind === "unsupported") {
    return { success: false, error: auth.error };
  }

  const cosign = await ensureCosignBinary();
  if (!cosign.path) {
    return { success: false, error: cosign.error ?? "cosign binary unavailable" };
  }

  const signedAt = Math.floor(Date.now() / 1000);
  let tempIdentityTokenPath: string | undefined;
  const authArgs: string[] = [];

  if (auth.kind === "github-actions") {
    authArgs.push("--oidc-provider", "github-actions", "--fulcio-auth-flow", "token");
  } else if (auth.kind === "identity-token-file") {
    authArgs.push("--identity-token", auth.tokenFile);
  } else {
    tempIdentityTokenPath = join(tmpdir(), `arc-sigstore-token-${process.pid}-${Date.now()}.token`);
    await writeFile(tempIdentityTokenPath, auth.token, { mode: 0o600 });
    authArgs.push("--identity-token", tempIdentityTokenPath);
  }

  const args = [
      cosign.path,
      "sign-blob",
      "--bundle", bundlePath,
      ...authArgs,
      "--yes",
      artifactPath,
  ];

  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  } finally {
    if (tempIdentityTokenPath) {
      await rm(tempIdentityTokenPath, { force: true }).catch(() => {
        // best-effort cleanup
      });
    }
  }

  const stdout = result.stdout?.toString().trim() ?? "";
  const stderr = result.stderr?.toString().trim() ?? "";

  if (result.exitCode === 0) {
    return {
      success: true,
      bundlePath,
      signerIdentity: auth.signerIdentity,
      signedAt,
      output: stdout || stderr,
    };
  }

  return {
    success: false,
    error: stderr || stdout || `cosign exited with code ${result.exitCode}`,
    output: stdout,
  };
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
