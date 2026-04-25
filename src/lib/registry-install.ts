import { join } from "path";
import { existsSync } from "fs";
import { writeFile, unlink, mkdir } from "fs/promises";
import type {
  PackageRef,
  VerifyResult,
  RegistrySource,
} from "../types.js";
import { getSourceType } from "./sources.js";
import { fetchMetafactoryPackageDetail } from "./metafactory-api.js";

// ---------------------------------------------------------------------------
// Package reference parsing
// ---------------------------------------------------------------------------

const PACKAGE_REF_RE = /^@?([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)(?:@([^@]+))?$/;

/** Parse @scope/name[@version] from CLI input. Returns null for URLs/paths. */
export function parsePackageRef(input: string): PackageRef | null {
  // Skip URLs and local paths
  if (input.startsWith("http") || input.startsWith("git@") || input.startsWith("file://")) return null;
  if (input.startsWith("./") || input.startsWith("/") || input.startsWith("~")) return null;

  const match = input.match(PACKAGE_REF_RE);
  if (!match) return null;

  return {
    scope: match[1]!,
    name: match[2]!,
    version: match[3] || undefined,
  };
}

/** Format a PackageRef as @scope/name[@version] */
export function formatPackageRef(ref: PackageRef): string {
  const base = `@${ref.scope}/${ref.name}`;
  return ref.version ? `${base}@${ref.version}` : base;
}

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

export interface ResolvedRegistryPackage {
  scope: string;
  name: string;
  version: string;
  sha256: string;
  downloadUrl: string;
  source: RegistrySource;
  /** F-501 registry signature — null for legacy/unsigned versions. */
  registrySignature: string | null;
  /** F-501 key identifier — null for legacy/unsigned versions. */
  registryKeyId: string | null;
  /** Exact manifest bytes as signed — required for A-504 verification. */
  manifestCanonical: string | null;
  /** F-009 Sigstore bundle R2 key — null if not sigstore-signed. */
  signatureBundleKey: string | null;
  /** F-008 expected signer identity (GitHub Actions workflow URI). */
  signerIdentity: string | null;
  /** Publish timestamp from the signing block (informational). */
  signedAt: string | null;
}

/** Resolve a package from metafactory registry sources (anonymous — no auth required per DD-80) */
export async function resolveFromRegistry(
  ref: PackageRef,
  sources: RegistrySource[],
): Promise<ResolvedRegistryPackage | null> {
  const mfSources = sources.filter((s) => getSourceType(s) === "metafactory");
  if (!mfSources.length) return null;

  for (const source of mfSources) {
    const detail = await fetchMetafactoryPackageDetail(source, `@${ref.scope}`, ref.name);
    if (!detail) continue;

    // Resolve version
    const targetVersion = ref.version ?? detail.latest_version;
    if (!targetVersion) continue;

    // Fetch per-version detail: returns sha256, signing (F-501), and
    // manifest_canonical (exact bytes as signed, required for A-504).
    const versionDetailUrl = `${source.url}/api/v1/packages/${encodeURIComponent(`@${ref.scope}`)}/${encodeURIComponent(ref.name)}@${encodeURIComponent(targetVersion)}`;
    try {
      const resp = await fetch(versionDetailUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) continue;

      const body = (await resp.json()) as {
        version: string;
        sha256: string;
        manifest_canonical?: string;
        signing?: {
          registry_signature: string | null;
          registry_key_id: string | null;
          signature_bundle_key?: string | null;
          signer_identity?: string | null;
          signed_at?: string | null;
        };
      };

      if (!body.sha256) continue;

      const downloadUrl = `${source.url}/api/v1/storage/download/${body.sha256}`;

      return {
        scope: ref.scope,
        name: ref.name,
        version: targetVersion,
        sha256: body.sha256,
        downloadUrl,
        source,
        registrySignature: body.signing?.registry_signature ?? null,
        registryKeyId: body.signing?.registry_key_id ?? null,
        manifestCanonical: body.manifest_canonical ?? null,
        signatureBundleKey: body.signing?.signature_bundle_key ?? null,
        signerIdentity: body.signing?.signer_identity ?? null,
        signedAt: body.signing?.signed_at ?? null,
      };
    } catch (_err) {
      // Network error, try next source
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadResult {
  success: boolean;
  tempPath?: string;
  bytesDownloaded?: number;
  error?: string;
}

/** Maximum number of HTTP redirects to follow on a single download. */
const MAX_REDIRECTS = 5;

/**
 * Fetch with explicit cross-origin Authorization stripping.
 *
 * If an auth'd request is redirected to a different origin (e.g. storage
 * 302s to a presigned R2/S3 URL), drop the Authorization header on the
 * next hop so the bearer token never reaches the redirect target. The
 * WHATWG `fetch` spec already mandates this, but pinning the contract
 * here protects against runtime changes and makes the intent observable
 * in tests. Same-origin redirects keep the header.
 *
 * After MAX_REDIRECTS hops without reaching a non-3xx response, throw —
 * never fall back to default fetch redirect-following, which would void
 * the no-leak contract this function exists to enforce.
 */
async function fetchFollowingRedirects(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<Response> {
  let currentUrl = url;
  let currentHeaders = { ...init.headers };
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, {
      headers: currentHeaders,
      signal: init.signal,
      redirect: "manual",
    });
    const status = response.status;
    if (status < 300 || status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
    currentUrl = nextUrl;
    if (!sameOrigin && currentHeaders.Authorization) {
      const { Authorization: _drop, ...rest } = currentHeaders;
      currentHeaders = rest;
    }
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) following ${url}`);
}

/**
 * Download a package tarball from the storage endpoint.
 *
 * When `source` is provided and is a metafactory source with a stored bearer
 * token, attaches `Authorization: Bearer <token>` so the request can pass
 * through an auth-gated storage endpoint (issue #83). For sources without a
 * token, or registry-type sources, the request stays anonymous (DD-80) so
 * public unauthenticated installs continue to work.
 *
 * Redirects are followed manually: on a cross-origin redirect (e.g. 302 to
 * a presigned R2/S3 URL), the Authorization header is stripped before the
 * next hop so the bearer never leaks to a third-party storage origin.
 */
export async function downloadPackage(
  url: string,
  tempDir: string,
  source?: RegistrySource,
): Promise<DownloadResult> {
  const tempPath = join(tempDir, `arc-download-${Date.now()}.tar.gz`);

  const headers: Record<string, string> = {};
  if (source && source.token && getSourceType(source) === "metafactory") {
    headers.Authorization = `Bearer ${source.token}`;
  }

  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchFollowingRedirects(url, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: "Access denied by storage endpoint." };
      }
      if (response.status === 404) {
        return { success: false, error: "Package artifact not found at storage endpoint." };
      }
      if (!response.ok) {
        lastError = `Download failed: HTTP ${response.status}`;
        continue;
      }

      const buffer = await response.arrayBuffer();
      await writeFile(tempPath, Buffer.from(buffer));

      return {
        success: true,
        tempPath,
        bytesDownloaded: buffer.byteLength,
      };
    } catch (_err) {
      lastError = "Download failed: network error. Check your connection and try again.";
    }
  }

  return { success: false, error: lastError };
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

/** Verify SHA-256 checksum of a downloaded file */
export async function verifyChecksum(
  filePath: string,
  expectedSha256: string,
): Promise<VerifyResult> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  const actual = hasher.digest("hex");

  return {
    valid: actual === expectedSha256.toLowerCase(),
    expected: expectedSha256.toLowerCase(),
    actual,
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractResult {
  success: boolean;
  extractedPath: string;
  error?: string;
}

/** Extract a tarball to the repos directory */
export async function extractPackage(
  tarballPath: string,
  reposDir: string,
  packageName: string,
): Promise<ExtractResult> {
  const extractedPath = join(reposDir, packageName);

  if (!existsSync(reposDir)) {
    await mkdir(reposDir, { recursive: true });
  }

  // Create target directory
  await mkdir(extractedPath, { recursive: true });

  const result = Bun.spawnSync(
    ["tar", "xzf", tarballPath, "-C", extractedPath, "--strip-components=1"],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    // Clean up partial extraction
    Bun.spawnSync(["rm", "-rf", extractedPath], { stdout: "pipe", stderr: "pipe" });
    return {
      success: false,
      extractedPath,
      error: `Extraction failed: ${result.stderr.toString().trim()}`,
    };
  }

  // Clean up tarball -- cleanup failure is non-fatal
  await unlink(tarballPath).catch((_err) => {});

  // Verify manifest exists
  const hasManifest = existsSync(join(extractedPath, "arc-manifest.yaml")) ||
    existsSync(join(extractedPath, "pai-manifest.yaml"));

  if (!hasManifest) {
    Bun.spawnSync(["rm", "-rf", extractedPath], { stdout: "pipe", stderr: "pipe" });
    return {
      success: false,
      extractedPath,
      error: "Package archive does not contain arc-manifest.yaml. Invalid package format.",
    };
  }

  return { success: true, extractedPath };
}
