import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { readManifest } from "./manifest.js";
import type { ArcManifest, BundleResult, PublishValidation } from "../types.js";

// ── Constants ────────────────────────────────────────────────

export const DEFAULT_EXCLUSIONS = [
  ".git",
  "node_modules",
  ".env",
  ".env.*",
  "*.db",
  "*.sqlite",
  ".DS_Store",
  "Thumbs.db",
  ".specify",
  "test",
  "tests",
  "dist",
  "*.log",
  ".wrangler",
  ".claude",
];

const MAX_PACKAGE_SIZE = 50 * 1024 * 1024; // 50MB
const WARN_PACKAGE_SIZE = 10 * 1024 * 1024; // 10MB

// ── Checksum ─────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a file */
export async function computeChecksum(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return hasher.digest("hex");
}

// ── Temp directory lifecycle ─────────────────────────────────

/** Execute a function with a temp directory that is cleaned up afterward */
export async function withTempDir<T>(
  fn: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "arc-publish-"));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Exclusion patterns ───────────────────────────────────────

/** Merge default exclusions with manifest overrides */
export function getExclusionPatterns(manifest: ArcManifest): string[] {
  const patterns = [...DEFAULT_EXCLUSIONS];
  if (manifest.bundle?.exclude) {
    patterns.push(...manifest.bundle.exclude);
  }
  return patterns;
}

// ── Publish validation ───────────────────────────────────────

const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/;

const VALID_TYPES = [
  "skill", "tool", "agent", "prompt", "component",
  "pipeline", "rules", "library", "action",
];

/** Validate a manifest for publishing (stricter than install validation) */
export function validateForPublish(manifest: ArcManifest): PublishValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest.name) {
    errors.push("name is required");
  } else if (!VALID_NAME_RE.test(manifest.name)) {
    errors.push("name must be lowercase alphanumeric with hyphens, dots, or underscores");
  }

  if (!manifest.version) {
    errors.push("version is required");
  } else if (!SEMVER_RE.test(manifest.version)) {
    errors.push(`version "${manifest.version}" is not valid semver`);
  }

  if (!manifest.type) {
    errors.push("type is required");
  } else if (!VALID_TYPES.includes(manifest.type)) {
    errors.push(`type "${manifest.type}" is not a recognized artifact type`);
  }

  if (!manifest.description) {
    warnings.push("description is missing (recommended for registry listing)");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    name: manifest.name ?? "",
    version: manifest.version ?? "",
  };
}

// ── Tarball creation ─────────────────────────────────────────

/** Create a .tar.gz bundle from a package directory */
export async function createBundle(
  packageDir: string,
  outputPath?: string,
): Promise<BundleResult> {
  const warnings: string[] = [];

  // Read manifest
  const manifest = await readManifest(packageDir);
  if (!manifest) {
    return {
      success: false,
      tarballPath: "",
      sha256: "",
      sizeBytes: 0,
      fileCount: 0,
      manifest: {} as ArcManifest,
      warnings: [],
      error: "No arc-manifest.yaml found in package directory",
    };
  }

  // Validate for publish
  const validation = validateForPublish(manifest);
  if (!validation.valid) {
    return {
      success: false,
      tarballPath: "",
      sha256: "",
      sizeBytes: 0,
      fileCount: 0,
      manifest,
      warnings: validation.warnings,
      error: `Manifest validation failed: ${validation.errors.join(", ")}`,
    };
  }
  warnings.push(...validation.warnings);

  // Check for README
  const hasReadme = existsSync(join(packageDir, "README.md")) ||
    existsSync(join(packageDir, "readme.md")) ||
    existsSync(join(packageDir, "Readme.md"));
  if (!hasReadme) {
    warnings.push("No README.md found (recommended for registry listing)");
  }

  // Build tar args
  const tarballName = outputPath ?? join(packageDir, `${manifest.name}-${manifest.version}.tar.gz`);
  const exclusions = getExclusionPatterns(manifest);
  // Handle bundle.include by removing those patterns from exclusions
  // (include overrides exclude — force specific paths into the tarball)
  const includePatterns = manifest.bundle?.include ?? [];

  const finalExcludeArgs: string[] = [];
  for (const pattern of exclusions) {
    const isOverridden = includePatterns.some((inc) => inc === pattern);
    if (!isOverridden) {
      finalExcludeArgs.push("--exclude", pattern);
    }
  }

  // Create tarball
  const result = Bun.spawnSync(
    ["tar", "czf", tarballName, ...finalExcludeArgs, "."],
    { cwd: packageDir, stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      tarballPath: tarballName,
      sha256: "",
      sizeBytes: 0,
      fileCount: 0,
      manifest,
      warnings,
      error: `tar failed: ${result.stderr.toString().trim()}`,
    };
  }

  // Compute checksum
  const sha256 = await computeChecksum(tarballName);

  // Get size
  const file = Bun.file(tarballName);
  const sizeBytes = file.size;

  // Get file count
  const listResult = Bun.spawnSync(
    ["tar", "tzf", tarballName],
    { stdout: "pipe", stderr: "pipe" },
  );
  const fileCount = listResult.stdout.toString().trim().split("\n").filter(Boolean).length;

  // Size checks
  if (sizeBytes > MAX_PACKAGE_SIZE) {
    // Clean up the tarball
    await rm(tarballName).catch(() => {});
    return {
      success: false,
      tarballPath: tarballName,
      sha256,
      sizeBytes,
      fileCount,
      manifest,
      warnings,
      error: `Package tarball exceeds 50MB limit (${(sizeBytes / 1024 / 1024).toFixed(1)}MB)`,
    };
  }

  if (sizeBytes > WARN_PACKAGE_SIZE) {
    warnings.push(`Tarball is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB (consider reducing size)`);
  }

  return {
    success: true,
    tarballPath: tarballName,
    sha256,
    sizeBytes,
    fileCount,
    manifest,
    warnings,
  };
}
