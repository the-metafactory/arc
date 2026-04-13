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

    // Fetch version detail to get SHA-256 (anonymous — no bearer token)
    const versionDetailUrl = `${source.url}/api/v1/packages/${encodeURIComponent(`@${ref.scope}`)}/${encodeURIComponent(ref.name)}/versions`;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };

      const resp = await fetch(versionDetailUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) continue;

      const body = (await resp.json()) as {
        versions: Array<{ version: string; sha256: string }>;
      };

      const versionEntry = body.versions.find((v) => v.version === targetVersion);
      if (!versionEntry) continue;

      const downloadUrl = `${source.url}/api/v1/storage/download/${versionEntry.sha256}`;

      return {
        scope: ref.scope,
        name: ref.name,
        version: targetVersion,
        sha256: versionEntry.sha256,
        downloadUrl,
        source,
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

/** Download a package tarball from the storage endpoint (anonymous) */
export async function downloadPackage(
  url: string,
  tempDir: string,
): Promise<DownloadResult> {
  const tempPath = join(tempDir, `arc-download-${Date.now()}.tar.gz`);

  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
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
