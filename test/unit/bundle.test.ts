import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import YAML from "yaml";
import {
  computeChecksum,
  withTempDir,
  getExclusionPatterns,
  validateForPublish,
  createBundle,
  DEFAULT_EXCLUSIONS,
} from "../../src/lib/bundle.js";
import { createPackageDir } from "../helpers/test-env.js";
import type { ArcManifest } from "../../src/types.js";

// ── Helper ───────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "arc-bundle-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function createMockPackage(
  dir: string,
  manifest: Partial<ArcManifest> & { name: string; version: string; type: string },
  opts?: { withReadme?: boolean; extraFiles?: Record<string, string> },
): Promise<string> {
  const fullManifest = {
    schema: "arc/v1",
    ...manifest,
    capabilities: manifest.capabilities ?? { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
  };
  return createPackageDir(dir, fullManifest, { ...opts, withSkillDir: false });
}

// ── computeChecksum ──────────────────────────────────────────

describe("computeChecksum", () => {
  test("returns SHA-256 hex digest", async () => {
    const filePath = join(testDir, "test.bin");
    await writeFile(filePath, "hello world");

    const hash = await computeChecksum(filePath);

    // Verify against known SHA-256 of "hello world"
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  test("returns lowercase hex", async () => {
    const filePath = join(testDir, "test.bin");
    await writeFile(filePath, "test");
    const hash = await computeChecksum(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── withTempDir ──────────────────────────────────────────────

describe("withTempDir", () => {
  test("provides existing directory during callback", async () => {
    let capturedDir = "";
    await withTempDir(async (dir) => {
      capturedDir = dir;
      expect(existsSync(dir)).toBe(true);
    });
    // After callback, directory should be cleaned up
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("cleans up even on error", async () => {
    let capturedDir = "";
    try {
      await withTempDir(async (dir) => {
        capturedDir = dir;
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(existsSync(capturedDir)).toBe(false);
  });
});

// ── getExclusionPatterns ─────────────────────────────────────

describe("getExclusionPatterns", () => {
  test("returns defaults when no manifest bundle config", () => {
    const manifest = { name: "test", version: "1.0.0", type: "skill" } as ArcManifest;
    const patterns = getExclusionPatterns(manifest);
    expect(patterns).toEqual(DEFAULT_EXCLUSIONS);
  });

  test("appends manifest bundle.exclude", () => {
    const manifest = {
      name: "test", version: "1.0.0", type: "skill",
      bundle: { exclude: ["*.tmp", "coverage"] },
    } as ArcManifest;
    const patterns = getExclusionPatterns(manifest);
    expect(patterns).toContain("*.tmp");
    expect(patterns).toContain("coverage");
    expect(patterns.length).toBe(DEFAULT_EXCLUSIONS.length + 2);
  });

  test("handles empty bundle config", () => {
    const manifest = {
      name: "test", version: "1.0.0", type: "skill",
      bundle: {},
    } as ArcManifest;
    const patterns = getExclusionPatterns(manifest);
    expect(patterns).toEqual(DEFAULT_EXCLUSIONS);
  });
});

describe("DEFAULT_EXCLUSIONS", () => {
  // Regression guard for https://github.com/the-metafactory/arc/issues/78 —
  // these patterns are the common build/cache directories that caused 278MB
  // bundles in monorepos. Each is confirmed to never belong in a published
  // arc package.
  const REQUIRED_PATTERNS = [
    ".git", "node_modules", ".env", ".env.*",
    "*.db", "*.sqlite", "*.log",
    ".DS_Store", "Thumbs.db",
    "dist", "build", "out",
    "coverage", ".nyc_output",
    ".next", ".turbo", ".parcel-cache", ".pnpm-store",
    ".*.bun-build",
    "target",
    ".venv", "__pycache__", "*.pyc",
    "*.tar.gz", "*.tgz",
    ".specify", ".wrangler", ".claude",
    "test", "tests",
  ];

  for (const pattern of REQUIRED_PATTERNS) {
    test(`includes ${pattern}`, () => {
      expect(DEFAULT_EXCLUSIONS).toContain(pattern);
    });
  }
});

// ── validateForPublish ───────────────────────────────────────

describe("validateForPublish", () => {
  test("valid manifest passes", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test skill",
    } as ArcManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing name fails", () => {
    const result = validateForPublish({
      version: "1.0.0",
      type: "skill",
    } as ArcManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("invalid name fails", () => {
    const result = validateForPublish({
      name: "My Skill!",
      version: "1.0.0",
      type: "skill",
    } as ArcManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("missing version fails", () => {
    const result = validateForPublish({
      name: "my-skill",
      type: "skill",
    } as ArcManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("invalid version fails", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "not-semver",
      type: "skill",
    } as ArcManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  test("missing description warns but passes", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
    } as ArcManifest);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("description"))).toBe(true);
  });

  test("invalid type fails", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "invalid" as any,
    } as ArcManifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("type"))).toBe(true);
  });
});

// ── createBundle ─────────────────────────────────────────────

describe("createBundle", () => {
  test("creates valid tarball from package directory", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
    });

    const result = await createBundle(pkgDir);

    expect(result.success).toBe(true);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.manifest.name).toBe("test-skill");
    expect(existsSync(result.tarballPath)).toBe(true);

    // Clean up tarball
    await rm(result.tarballPath).catch(() => {});
  });

  test("excludes default patterns", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
    }, {
      extraFiles: {
        ".git/config": "gitconfig",
        "node_modules/dep/index.js": "module.exports = {}",
        ".env": "SECRET=foo",
        ".DS_Store": "junk",
      },
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);

    // List tarball contents
    const listResult = Bun.spawnSync(["tar", "tzf", result.tarballPath], { stdout: "pipe" });
    const contents = listResult.stdout.toString();

    expect(contents).not.toContain(".git/");
    expect(contents).not.toContain("node_modules/");
    expect(contents).not.toContain(".env");
    expect(contents).not.toContain(".DS_Store");

    await rm(result.tarballPath).catch(() => {});
  });

  test("excludes new build/cache defaults (bun, rust, python, frameworks)", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
    }, {
      extraFiles: {
        ".cli.bun-build": "binary blob",         // .*.bun-build
        "target/release/app": "rust binary",     // target
        ".venv/bin/python": "venv",              // .venv
        "__pycache__/mod.cpython.pyc": "pyc",    // __pycache__
        "build/index.js": "build output",        // build
        "out/index.html": "out output",          // out
        "coverage/lcov.info": "coverage",        // coverage
        ".next/build-manifest.json": "{}",       // .next
        ".turbo/cache.json": "{}",               // .turbo
        "prev-bundle-1.0.0.tar.gz": "prior",     // *.tar.gz
      },
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);

    const listResult = Bun.spawnSync(["tar", "tzf", result.tarballPath], { stdout: "pipe" });
    const contents = listResult.stdout.toString();

    expect(contents).not.toContain(".cli.bun-build");
    expect(contents).not.toContain("target/");
    expect(contents).not.toContain(".venv/");
    expect(contents).not.toContain("__pycache__/");
    expect(contents).not.toContain("build/");
    expect(contents).not.toContain("out/");
    expect(contents).not.toContain("coverage/");
    expect(contents).not.toContain(".next/");
    expect(contents).not.toContain(".turbo/");
    expect(contents).not.toContain("prev-bundle-1.0.0.tar.gz");

    await rm(result.tarballPath).catch(() => {});
  });

  test("bundle.include overrides exclusions", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
      bundle: { include: ["test"] },
    }, {
      extraFiles: {
        "test/test.ts": "test code",
      },
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);

    // "test" should be included since bundle.include overrides
    const listResult = Bun.spawnSync(["tar", "tzf", result.tarballPath], { stdout: "pipe" });
    const contents = listResult.stdout.toString();
    expect(contents).toContain("test/");

    // Matching include should NOT produce the orphan-include warning
    expect(result.warnings.some((w) => w.includes("bundle.include has no effect"))).toBe(false);

    await rm(result.tarballPath).catch(() => {});
  });

  test("warns when bundle.include entries match no default exclusion", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
      bundle: { include: ["packages/specflow/**", "src/only"] },
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);

    const warning = result.warnings.find((w) => w.includes("bundle.include has no effect"));
    expect(warning).toBeDefined();
    expect(warning).toContain("packages/specflow/**");
    expect(warning).toContain("src/only");

    await rm(result.tarballPath).catch(() => {});
  });

  test("no orphan-include warning when bundle.include is empty or absent", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes("bundle.include has no effect"))).toBe(false);

    await rm(result.tarballPath).catch(() => {});
  });

  test("warns with mix of matching and orphan includes", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
      bundle: { include: ["test", "packages/foo"] },
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);

    const warning = result.warnings.find((w) => w.includes("bundle.include has no effect"));
    expect(warning).toBeDefined();
    expect(warning).toContain("packages/foo");
    expect(warning).not.toContain("[test,");
    expect(warning).not.toContain("[test ");

    await rm(result.tarballPath).catch(() => {});
  });

  test("include that cancels a user-defined bundle.exclude produces no warning", async () => {
    // Regression test for PR #81 review nit — include can cancel any exclusion
    // in the merged set, not only DEFAULT_EXCLUSIONS. A user-defined exclude
    // cancelled by include is a legitimate pattern, not an orphan.
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
      bundle: {
        exclude: ["fixtures/large"],
        include: ["fixtures/large"],
      },
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes("bundle.include has no effect"))).toBe(false);

    await rm(result.tarballPath).catch(() => {});
  });

  test("warns when no README.md", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
    }, { withReadme: false });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes("README"))).toBe(true);

    await rm(result.tarballPath).catch(() => {});
  });

  test("custom output path", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test-skill",
      version: "1.0.0",
      type: "skill",
      description: "A test",
    });

    const customOutput = join(testDir, "custom-output.tar.gz");
    const result = await createBundle(pkgDir, customOutput);

    expect(result.success).toBe(true);
    expect(result.tarballPath).toBe(customOutput);
    expect(existsSync(customOutput)).toBe(true);

    await rm(customOutput).catch(() => {});
  });

  test("returns error for missing manifest", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir, { recursive: true });

    const result = await createBundle(emptyDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("arc-manifest.yaml");
  });

  test("returns error for invalid manifest", async () => {
    const pkgDir = await createMockPackage(testDir, {
      name: "test",
      version: "not-semver",
      type: "skill",
    });

    const result = await createBundle(pkgDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation failed");
  });
});
