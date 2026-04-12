import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import YAML from "yaml";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { bundle, formatBundle } from "../../src/commands/bundle.js";

let env: TestEnv;
let testDir: string;

beforeEach(async () => {
  env = await createTestEnv();
  testDir = await mkdtemp(join(tmpdir(), "arc-bundle-cmd-"));
});

afterEach(async () => {
  await env.cleanup();
  await rm(testDir, { recursive: true, force: true });
});

async function createPackage(
  dir: string,
  manifest: Record<string, any>,
  opts?: { withReadme?: boolean },
): Promise<string> {
  const pkgDir = join(dir, "pkg");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "arc-manifest.yaml"), YAML.stringify(manifest));
  await mkdir(join(pkgDir, "skill"), { recursive: true });
  await writeFile(join(pkgDir, "skill/SKILL.md"), "# Test\n\nSkill content.\n");
  if (opts?.withReadme !== false) {
    await writeFile(join(pkgDir, "README.md"), "# Test Package\n");
  }
  return pkgDir;
}

describe("arc bundle command", () => {
  test("bundles a valid package", async () => {
    const pkgDir = await createPackage(testDir, {
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "A skill",
      capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
    });

    const result = await bundle({ paths: env.paths, packageDir: pkgDir });

    expect(result.success).toBe(true);
    expect(result.name).toBe("my-skill");
    expect(result.version).toBe("1.0.0");
    expect(result.type).toBe("skill");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tarballPath).toBeDefined();
    expect(existsSync(result.tarballPath!)).toBe(true);

    // Clean up
    await rm(result.tarballPath!).catch(() => {});
  });

  test("custom output path", async () => {
    const pkgDir = await createPackage(testDir, {
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "A skill",
      capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
    });

    const outputPath = join(testDir, "custom.tar.gz");
    const result = await bundle({ paths: env.paths, packageDir: pkgDir, outputPath });

    expect(result.success).toBe(true);
    expect(result.tarballPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);

    await rm(outputPath).catch(() => {});
  });

  test("fails with missing manifest", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir, { recursive: true });

    const result = await bundle({ paths: env.paths, packageDir: emptyDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("arc-manifest.yaml");
  });

  test("fails with invalid manifest", async () => {
    const pkgDir = await createPackage(testDir, {
      name: "My Bad Name!",
      version: "not-semver",
      type: "skill",
      capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
    });

    const result = await bundle({ paths: env.paths, packageDir: pkgDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation failed");
  });

  test("formatBundle produces readable output", async () => {
    const result = {
      success: true,
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      tarballPath: "/tmp/my-skill-1.0.0.tar.gz",
      sha256: "abc123def456",
      sizeBytes: 24576,
      fileCount: 12,
      warnings: [],
    };

    const output = formatBundle(result);
    expect(output).toContain("Bundled my-skill v1.0.0");
    expect(output).toContain("Type:     skill");
    expect(output).toContain("Files:    12");
    expect(output).toContain("SHA-256:  abc123def456");
  });

  test("formatBundle includes warnings", () => {
    const result = {
      success: true,
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      tarballPath: "/tmp/test.tar.gz",
      sha256: "abc123",
      sizeBytes: 100,
      fileCount: 1,
      warnings: ["No README.md found"],
    };

    const output = formatBundle(result);
    expect(output).toContain("Warning: No README.md found");
  });

  test("formatBundle shows error on failure", () => {
    const result = {
      success: false,
      error: "Something went wrong",
    };

    const output = formatBundle(result);
    expect(output).toContain("Error: Something went wrong");
  });
});
