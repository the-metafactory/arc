import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractReadme,
  resolvePublishScope,
  uploadBundle,
  uploadSigstoreBundle,
  ensurePackageExists,
  registerVersion,
  combineError,
  toServerManifest,
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
  };
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

// ── uploadSigstoreBundle ────────────────────────────────────

describe("uploadSigstoreBundle", () => {
  test("successful upload returns bundle key", async () => {
    const bundlePath = join(testDir, "test.bundle");
    const sha = "a".repeat(64);
    await writeFile(bundlePath, JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle+json" }));

    mockFetch(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe(`https://meta-factory.test/api/v1/storage/bundle/${sha}`);
      expect(init?.method).toBe("PUT");
      return new Response(
        JSON.stringify({ sha256: sha, bundle_key: `packages/${sha}.bundle`, size_bytes: 123 }),
        { status: 201 },
      );
    });

    const result = await uploadSigstoreBundle(bundlePath, makeSource(), sha);
    expect(result.success).toBe(true);
    expect(result.bundleKey).toBe(`packages/${sha}.bundle`);
  });

  test("409 treated as idempotent success", async () => {
    const bundlePath = join(testDir, "test.bundle");
    const sha = "b".repeat(64);
    await writeFile(bundlePath, "{}");

    mockFetch(async () => new Response(
      JSON.stringify({ error: "Conflict", message: "Bundle already exists" }),
      { status: 409 },
    ));

    const result = await uploadSigstoreBundle(bundlePath, makeSource(), sha);
    expect(result.success).toBe(true);
    expect(result.bundleKey).toBe(`packages/${sha}.bundle`);
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

  test("includes Sigstore metadata in registration payload", async () => {
    let requestBody: any;
    mockFetch(async (_url: any, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON string body");
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ version_id: "uuid-signed" }),
        { status: 201 },
      );
    });

    const result = await registerVersion(makeSource(), "ns", "pkg", {
      ...payload,
      signature_bundle_key: "packages/abc123.bundle",
      signer_identity: "https://github.com/the-metafactory/arc/.github/workflows/publish.yml@refs/heads/main",
      signed_at: 1_780_000_000,
    });
    expect(result.success).toBe(true);
    expect(requestBody.signature_bundle_key).toBe("packages/abc123.bundle");
    expect(requestBody.signer_identity).toContain("publish.yml");
    expect(requestBody.signed_at).toBe(1_780_000_000);
  });

  test("preserves zero-valued signed_at in registration payload", async () => {
    let requestBody: any;
    mockFetch(async (_url: any, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON string body");
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ version_id: "uuid-signed-zero" }),
        { status: 201 },
      );
    });

    const result = await registerVersion(makeSource(), "ns", "pkg", {
      ...payload,
      signature_bundle_key: "packages/abc123.bundle",
      signer_identity: "https://github.com/the-metafactory/arc/.github/workflows/publish.yml@refs/heads/main",
      signed_at: 0,
    });
    expect(result.success).toBe(true);
    expect(requestBody.signed_at).toBe(0);
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

// ── combineError helper ──────────────────────────────────────

describe("combineError", () => {
  test("prefers message over error", () => {
    expect(combineError({ error: "E_X", message: "Detail explanation" })).toBe("Detail explanation");
  });

  test("falls back to error when message missing", () => {
    expect(combineError({ error: "E_X" })).toBe("E_X");
  });

  test("falls back to error when message empty string", () => {
    expect(combineError({ error: "E_X", message: "" })).toBe("E_X");
  });

  test("returns undefined for empty body", () => {
    expect(combineError({})).toBeUndefined();
  });

  test("returns undefined for null/undefined", () => {
    expect(combineError(null)).toBeUndefined();
    expect(combineError(undefined)).toBeUndefined();
  });
});

// Regression tests for https://github.com/the-metafactory/arc/issues/79
describe("toServerManifest — network capability coercion", () => {
  test("object form produces {domain}", () => {
    const m = makeManifest({
      capabilities: {
        network: [
          { domain: "github.com", reason: "clone repos" },
          { domain: "api.example.com", reason: "telemetry" },
        ],
      },
    });
    const server = toServerManifest(m, "test");
    expect(server.capabilities).toEqual({
      network: [{ domain: "github.com" }, { domain: "api.example.com" }],
    });
  });

  test("string shorthand produces {domain} (defensive path)", () => {
    // Simulates a manifest that bypassed readManifest normalisation.
    const m = makeManifest({
      capabilities: {
        network: ["github.com", "agentskills.io"] as unknown as { domain: string; reason: string }[],
      },
    });
    const server = toServerManifest(m, "test");
    expect(server.capabilities).toEqual({
      network: [{ domain: "github.com" }, { domain: "agentskills.io" }],
    });
  });

  test("never produces {domain: undefined} under any input shape", () => {
    const m = makeManifest({
      capabilities: {
        network: [
          "github.com",
          { domain: "good.com", reason: "ok" },
          { reason: "no domain" },
          null,
          undefined,
          42,
        ] as unknown as { domain: string; reason: string }[],
      },
    });
    const server = toServerManifest(m, "test");
    const netCaps = (server.capabilities as any).network as { domain: unknown }[];
    for (const entry of netCaps) {
      expect(typeof entry.domain).toBe("string");
      expect(entry.domain).not.toBe("");
    }
    expect(netCaps).toEqual([{ domain: "github.com" }, { domain: "good.com" }]);
  });

  test("empty network array produces no network entry in server caps", () => {
    const m = makeManifest({ capabilities: { network: [] } });
    const server = toServerManifest(m, "test");
    expect((server.capabilities as any).network).toBeUndefined();
  });
});

// Forwards optional discovery / provenance metadata from arc-manifest.yaml
// to the registry. Without this, `repository` (and friends) never reach
// MetafactoryManifest, the registry treats every package as
// repository-less, and the same-repo image rewrite for README rendering
// stays closed (the-metafactory/meta-factory#501 / #502 / #505).
describe("toServerManifest — optional metadata forwarding", () => {
  test("forwards repository when set", () => {
    const m = makeManifest({
      repository: "https://github.com/the-metafactory/soma",
    });
    const server = toServerManifest(m, "metafactory");
    expect(server.repository).toBe("https://github.com/the-metafactory/soma");
  });

  test("omits repository when absent (no empty-string poisoning)", () => {
    const m = makeManifest();
    const server = toServerManifest(m, "metafactory");
    expect("repository" in server).toBe(false);
  });

  test("omits repository when empty string", () => {
    const m = makeManifest({ repository: "" });
    const server = toServerManifest(m, "metafactory");
    expect("repository" in server).toBe(false);
  });

  test("forwards homepage when set", () => {
    const m = makeManifest({ homepage: "https://soma.metafactory.ai" });
    const server = toServerManifest(m, "metafactory");
    expect(server.homepage).toBe("https://soma.metafactory.ai");
  });

  test("omits homepage when absent", () => {
    const m = makeManifest();
    const server = toServerManifest(m, "metafactory");
    expect("homepage" in server).toBe(false);
  });

  test("forwards keywords array when non-empty", () => {
    const m = makeManifest({ keywords: ["pai", "memory", "identity"] });
    const server = toServerManifest(m, "metafactory");
    expect(server.keywords).toEqual(["pai", "memory", "identity"]);
  });

  test("omits keywords when absent", () => {
    const m = makeManifest();
    const server = toServerManifest(m, "metafactory");
    expect("keywords" in server).toBe(false);
  });

  test("omits keywords when empty array (no [] poisoning)", () => {
    const m = makeManifest({ keywords: [] });
    const server = toServerManifest(m, "metafactory");
    expect("keywords" in server).toBe(false);
  });

  test("forwards category when set", () => {
    const m = makeManifest({ category: "devtools" });
    const server = toServerManifest(m, "metafactory");
    expect(server.category).toBe("devtools");
  });

  test("omits category when absent", () => {
    const m = makeManifest();
    const server = toServerManifest(m, "metafactory");
    expect("category" in server).toBe(false);
  });

  test("forwards every optional metadata field together", () => {
    const m = makeManifest({
      description: "Soma in one line",
      repository: "https://github.com/the-metafactory/soma",
      homepage: "https://meta-factory.ai/package/@metafactory/soma",
      keywords: ["pai", "soma"],
      category: "devtools",
    });
    const server = toServerManifest(m, "metafactory");
    expect(server.description).toBe("Soma in one line");
    expect(server.repository).toBe(
      "https://github.com/the-metafactory/soma",
    );
    expect(server.homepage).toBe(
      "https://meta-factory.ai/package/@metafactory/soma",
    );
    expect(server.keywords).toEqual(["pai", "soma"]);
    expect(server.category).toBe("devtools");
  });
});
