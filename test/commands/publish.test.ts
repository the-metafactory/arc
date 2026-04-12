import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { publish, formatPublish } from "../../src/commands/publish.js";
import { saveSources } from "../../src/lib/sources.js";
import type { SourcesConfig } from "../../src/types.js";

let env: TestEnv;
let testDir: string;
let savedFetch: typeof fetch;

function mockFetch(fn: (...args: any[]) => Promise<Response>): void {
  (globalThis as any).fetch = fn;
}

beforeEach(async () => {
  env = await createTestEnv();
  testDir = await mkdtemp(join(tmpdir(), "arc-publish-cmd-"));
  savedFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await env.cleanup();
  await rm(testDir, { recursive: true, force: true });
});

function metafactorySource(token = "test-token"): SourcesConfig {
  return {
    sources: [{
      name: "mf-test",
      url: "https://meta-factory.test",
      tier: "official",
      enabled: true,
      type: "metafactory",
      token,
    }],
  };
}

async function createPackage(dir: string, manifest: Record<string, any>): Promise<string> {
  const pkgDir = join(dir, "pkg");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "arc-manifest.yaml"), YAML.stringify(manifest));
  await mkdir(join(pkgDir, "skill"), { recursive: true });
  await writeFile(join(pkgDir, "skill/SKILL.md"), "# Test\n");
  await writeFile(join(pkgDir, "README.md"), "# Test Package\n");
  return pkgDir;
}

const validManifest = {
  name: "my-skill",
  version: "1.0.0",
  type: "skill",
  description: "A skill",
  namespace: "testns",
  capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
};

describe("arc publish command", () => {
  test("fails without metafactory source", async () => {
    await saveSources(env.paths.sourcesPath, { sources: [] });
    const pkgDir = await createPackage(testDir, validManifest);

    const result = await publish({ paths: env.paths, packageDir: pkgDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("metafactory");
  });

  test("fails without authentication", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource(undefined as any));
    // Remove token by saving without it
    await saveSources(env.paths.sourcesPath, {
      sources: [{
        name: "mf-test",
        url: "https://meta-factory.test",
        tier: "official",
        enabled: true,
        type: "metafactory",
      }],
    });
    const pkgDir = await createPackage(testDir, validManifest);

    const result = await publish({ paths: env.paths, packageDir: pkgDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("login");
  });

  test("dry-run validates without uploading", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource());
    const pkgDir = await createPackage(testDir, validManifest);

    // No fetch mock needed — dry run should not make any HTTP calls
    const result = await publish({ paths: env.paths, packageDir: pkgDir, dryRun: true });
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.name).toBe("my-skill");
    expect(result.version).toBe("1.0.0");
    expect(result.scope).toBe("testns");
  });

  test("scope override via --scope flag", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource());
    const pkgDir = await createPackage(testDir, validManifest);

    const result = await publish({
      paths: env.paths,
      packageDir: pkgDir,
      dryRun: true,
      scope: "custom-ns",
    });
    expect(result.success).toBe(true);
    expect(result.scope).toBe("custom-ns");
  });

  test("full publish flow with mocked API", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource());
    const pkgDir = await createPackage(testDir, validManifest);

    let uploadCalled = false;
    let ensureCalled = false;
    let registerCalled = false;

    mockFetch(async (url: any) => {
      const urlStr = String(url);

      if (urlStr.includes("/storage/upload")) {
        uploadCalled = true;
        return new Response(
          JSON.stringify({ sha256: "any-sha", r2_key: "packages/any-sha.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/versions")) {
        registerCalled = true;
        return new Response(JSON.stringify({ version_id: "uuid-1" }), { status: 201 });
      }

      if (urlStr.includes("/packages/")) {
        ensureCalled = true;
        return new Response(JSON.stringify({ namespace: "testns", name: "my-skill" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const result = await publish({ paths: env.paths, packageDir: pkgDir });
    expect(result.success).toBe(true);
    expect(result.name).toBe("my-skill");
    expect(result.version).toBe("1.0.0");
    expect(uploadCalled).toBe(true);
    expect(ensureCalled).toBe(true);
    expect(registerCalled).toBe(true);
  });

  test("version exists error (409)", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource());
    const pkgDir = await createPackage(testDir, validManifest);

    mockFetch(async (url: any) => {
      const urlStr = String(url);

      if (urlStr.includes("/storage/upload")) {
        return new Response(
          JSON.stringify({ sha256: "x", r2_key: "packages/x.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/versions")) {
        return new Response(
          JSON.stringify({ error: "Version 1.0.0 already exists" }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/packages/")) {
        return new Response(JSON.stringify({ namespace: "testns", name: "my-skill" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const result = await publish({ paths: env.paths, packageDir: pkgDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("immutable");
  });

  test("formatPublish dry run output", () => {
    const output = formatPublish({
      success: true,
      name: "my-skill",
      version: "1.0.0",
      scope: "testns",
      sha256: "abc123",
      dryRun: true,
    });
    expect(output).toContain("[DRY RUN]");
    expect(output).toContain("@testns/my-skill");
  });

  test("formatPublish success output", () => {
    const output = formatPublish({
      success: true,
      name: "my-skill",
      version: "1.0.0",
      scope: "testns",
      sha256: "abc123",
      url: "https://meta-factory.ai/package/@testns/my-skill",
    });
    expect(output).toContain("Published @testns/my-skill");
    expect(output).toContain("URL:");
  });

  test("formatPublish error output", () => {
    const output = formatPublish({
      success: false,
      error: "Not authenticated",
    });
    expect(output).toContain("Error: Not authenticated");
  });
});
