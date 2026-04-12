import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractReadme,
  resolvePublishScope,
  uploadBundle,
  ensurePackageExists,
  registerVersion,
} from "../../src/lib/publish.js";
import { mockFetch } from "../helpers/mock-fetch.js";
import type { ArcManifest, RegistrySource } from "../../src/types.js";

// ── Helper ───────────────────────────────────────────────────

let testDir: string;
let savedFetch: typeof fetch;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "arc-publish-test-"));
  savedFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await rm(testDir, { recursive: true, force: true });
});

function makeSource(token = "test-token"): RegistrySource {
  return {
    name: "test-mf",
    url: "https://meta-factory.test",
    tier: "official",
    enabled: true,
    type: "metafactory",
    token,
  };
}

function makeManifest(overrides?: Partial<ArcManifest>): ArcManifest {
  return {
    name: "test-skill",
    version: "1.0.0",
    type: "skill",
    description: "A test",
    ...overrides,
  } as ArcManifest;
}

// ── extractReadme ────────────────────────────────────────────

describe("extractReadme", () => {
  test("returns README.md content", async () => {
    await writeFile(join(testDir, "README.md"), "# Hello\n\nWorld");
    const result = await extractReadme(testDir);
    expect(result).toBe("# Hello\n\nWorld");
  });

  test("returns readme.md content (lowercase)", async () => {
    await writeFile(join(testDir, "readme.md"), "# hello");
    const result = await extractReadme(testDir);
    expect(result).toBe("# hello");
  });

  test("returns Readme.md content (title case)", async () => {
    await writeFile(join(testDir, "Readme.md"), "# Readme");
    const result = await extractReadme(testDir);
    expect(result).toBe("# Readme");
  });

  test("returns null when no README", async () => {
    const result = await extractReadme(testDir);
    expect(result).toBeNull();
  });
});

// ── resolvePublishScope ──────────────────────────────────────

describe("resolvePublishScope", () => {
  test("CLI scope takes precedence", async () => {
    const manifest = makeManifest({ namespace: "manifest-ns" });
    const result = await resolvePublishScope(manifest, makeSource(), "cli-ns");
    expect(result).toBe("cli-ns");
  });

  test("manifest namespace used when no CLI scope", async () => {
    const manifest = makeManifest({ namespace: "manifest-ns" });
    const result = await resolvePublishScope(manifest, makeSource());
    expect(result).toBe("manifest-ns");
  });

  test("API fallback when neither available", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ namespace: "api-ns" }),
      { status: 200 },
    ));

    const manifest = makeManifest();
    const result = await resolvePublishScope(manifest, makeSource());
    expect(result).toBe("api-ns");
  });

  test("returns null when API fails", async () => {
    mockFetch(async () => new Response("error", { status: 500 }));

    const manifest = makeManifest();
    const result = await resolvePublishScope(manifest, makeSource());
    expect(result).toBeNull();
  });

  test("returns null when no token", async () => {
    const manifest = makeManifest();
    const source = makeSource();
    delete source.token;
    const result = await resolvePublishScope(manifest, source);
    expect(result).toBeNull();
  });
});

// ── uploadBundle ─────────────────────────────────────────────

describe("uploadBundle", () => {
  test("successful upload returns result", async () => {
    const filePath = join(testDir, "test.tar.gz");
    await writeFile(filePath, "tarball content");

    mockFetch(async () => new Response(
      JSON.stringify({ sha256: "abc123", r2_key: "packages/abc123.tar.gz", size_bytes: 15 }),
      { status: 201 },
    ));

    const result = await uploadBundle(filePath, makeSource(), "abc123");
    expect(result.success).toBe(true);
    expect(result.sha256).toBe("abc123");
    expect(result.r2Key).toBe("packages/abc123.tar.gz");
  });

  test("SHA-256 mismatch returns error", async () => {
    const filePath = join(testDir, "test.tar.gz");
    await writeFile(filePath, "tarball content");

    mockFetch(async () => new Response(
      JSON.stringify({ sha256: "server-hash", r2_key: "packages/server-hash.tar.gz", size_bytes: 15 }),
      { status: 201 },
    ));

    const result = await uploadBundle(filePath, makeSource(), "client-hash");
    expect(result.success).toBe(false);
    expect(result.error).toContain("SHA-256 mismatch");
  });

  test("401 returns auth error", async () => {
    const filePath = join(testDir, "test.tar.gz");
    await writeFile(filePath, "tarball content");

    mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    const result = await uploadBundle(filePath, makeSource(), "hash");
    expect(result.success).toBe(false);
    expect(result.error).toContain("login");
  });

  test("409 treated as success (idempotent)", async () => {
    const filePath = join(testDir, "test.tar.gz");
    await writeFile(filePath, "tarball content");

    mockFetch(async () => new Response(
      JSON.stringify({ sha256: "abc123", r2_key: "packages/abc123.tar.gz", size_bytes: 15 }),
      { status: 409 },
    ));

    const result = await uploadBundle(filePath, makeSource(), "abc123");
    expect(result.success).toBe(true);
  });
});

// ── ensurePackageExists ──────────────────────────────────────

describe("ensurePackageExists", () => {
  test("returns exists=true when package already exists", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ namespace: "ns", name: "pkg" }),
      { status: 200 },
    ));

    const result = await ensurePackageExists(makeSource(), "ns", "pkg", makeManifest());
    expect(result.exists).toBe(true);
    expect(result.created).toBe(false);
  });

  test("creates package when 404", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(JSON.stringify({ namespace: "ns", name: "pkg" }), { status: 201 });
    });

    const result = await ensurePackageExists(makeSource(), "ns", "pkg", makeManifest());
    expect(result.exists).toBe(true);
    expect(result.created).toBe(true);
  });

  test("returns error on 403 namespace not owned", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ error: "Forbidden" }),
      { status: 403 },
    ));

    const result = await ensurePackageExists(makeSource(), "ns", "pkg", makeManifest());
    expect(result.exists).toBe(false);
    expect(result.error).toContain("namespace");
  });
});

// ── registerVersion ──────────────────────────────────────────

describe("registerVersion", () => {
  const payload = {
    version: "1.0.0",
    sha256: "abc123",
    r2_key: "packages/abc123.tar.gz",
    size_bytes: 1000,
    manifest: makeManifest(),
    scope: "ns",
  };

  test("successful registration", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ version_id: "uuid-123" }),
      { status: 201 },
    ));

    const result = await registerVersion(makeSource(), "ns", "pkg", payload);
    expect(result.success).toBe(true);
    expect(result.versionId).toBe("uuid-123");
  });

  test("409 version exists", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ error: "Already exists" }),
      { status: 409 },
    ));

    const result = await registerVersion(makeSource(), "ns", "pkg", payload);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(result.error).toContain("immutable");
  });

  test("400 validation failed", async () => {
    mockFetch(async () => new Response(
      JSON.stringify({ error: "Missing field" }),
      { status: 400 },
    ));

    const result = await registerVersion(makeSource(), "ns", "pkg", payload);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  test("retries on 500 error", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal error", { status: 500 });
      }
      return new Response(JSON.stringify({ version_id: "uuid-retry" }), { status: 201 });
    });

    const result = await registerVersion(makeSource(), "ns", "pkg", payload);
    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });
});
