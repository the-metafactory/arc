import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createTestEnv, createPackageDir, type TestEnv } from "../helpers/test-env.js";
import { mockFetch } from "../helpers/mock-fetch.js";
import { publish, formatPublish } from "../../src/commands/publish.js";
import { saveSources } from "../../src/lib/sources.js";
import type { SourcesConfig } from "../../src/types.js";

let env: TestEnv;
let testDir: string;
let savedFetch: typeof fetch;

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
    await saveSources(env.arc.sourcesPath, { sources: [] });
    const pkgDir = await createPackageDir(testDir, validManifest);

    const result = await publish({ paths: env.arc, packageDir: pkgDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("metafactory");
  });

  test("fails without authentication", async () => {
    await saveSources(env.arc.sourcesPath, {
      sources: [{
        name: "mf-test",
        url: "https://meta-factory.test",
        tier: "official",
        enabled: true,
        type: "metafactory",
      }],
    });
    const pkgDir = await createPackageDir(testDir, validManifest);

    const result = await publish({ paths: env.arc, packageDir: pkgDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("login");
  });

  test("dry-run validates without uploading", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

    // No fetch mock needed — dry run should not make any HTTP calls
    const result = await publish({ paths: env.arc, packageDir: pkgDir, dryRun: true });
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.name).toBe("my-skill");
    expect(result.version).toBe("1.0.0");
    expect(result.scope).toBe("testns");
  });

  test("scope override via --scope flag", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

    const result = await publish({
      paths: env.arc,
      packageDir: pkgDir,
      dryRun: true,
      scope: "custom-ns",
    });
    expect(result.success).toBe(true);
    expect(result.scope).toBe("custom-ns");
  });

  test("full publish flow with mocked API", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

    let uploadCalled = false;
    let bundleUploadCalled = false;
    let ensureCalled = false;
    let registerCalled = false;
    let registerBody: any;

    mockFetch(async (url: any, init?: RequestInit) => {
      const urlStr = String(url);

      if (urlStr.includes("/storage/upload")) {
        uploadCalled = true;
        return new Response(
          JSON.stringify({ sha256: "any-sha", r2_key: "packages/any-sha.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/storage/bundle/")) {
        bundleUploadCalled = true;
        return new Response(
          JSON.stringify({ sha256: "any-sha", bundle_key: "packages/any-sha.bundle", size_bytes: 321 }),
          { status: 201 },
        );
      }

      if (urlStr.includes("/versions")) {
        registerCalled = true;
        if (typeof init?.body !== "string") throw new Error("expected JSON string body");
        registerBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ version_id: "uuid-1" }), { status: 201 });
      }

      if (urlStr.includes("/packages/")) {
        ensureCalled = true;
        return new Response(JSON.stringify({ namespace: "testns", name: "my-skill" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const result = await publish({
      paths: env.arc,
      packageDir: pkgDir,
      signer: async (_artifactPath, bundlePath) => {
        await writeFile(bundlePath, JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle+json" }));
        return {
          success: true,
          bundlePath,
          signerIdentity: "https://github.com/the-metafactory/arc/.github/workflows/publish.yml@refs/heads/main",
          signedAt: 1_780_000_000,
        };
      },
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe("my-skill");
    expect(result.version).toBe("1.0.0");
    expect(uploadCalled).toBe(true);
    expect(bundleUploadCalled).toBe(true);
    expect(ensureCalled).toBe(true);
    expect(registerCalled).toBe(true);
    expect(registerBody.signature_bundle_key).toBe("packages/any-sha.bundle");
    expect(registerBody.signer_identity).toContain("publish.yml");
    expect(registerBody.signed_at).toBe(1_780_000_000);
  });

  test("official publish fails closed when signing is unavailable", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

    mockFetch(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/storage/upload")) {
        return new Response(
          JSON.stringify({ sha256: "any-sha", r2_key: "packages/any-sha.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }
      return new Response("Unexpected", { status: 500 });
    });

    const result = await publish({
      paths: env.arc,
      packageDir: pkgDir,
      signer: async () => ({ success: false, error: "cosign binary unavailable" }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Sigstore signing failed");
  });

  test("official publish fails before uploading when ambient signing would be interactive", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);
    let fetchCalled = false;
    const saved = {
      ARC_SIGSTORE_IDENTITY_TOKEN: process.env.ARC_SIGSTORE_IDENTITY_TOKEN,
      ARC_SIGSTORE_IDENTITY_TOKEN_FILE: process.env.ARC_SIGSTORE_IDENTITY_TOKEN_FILE,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      GITHUB_WORKFLOW_REF: process.env.GITHUB_WORKFLOW_REF,
    };

    mockFetch(async () => {
      fetchCalled = true;
      return new Response("Unexpected", { status: 500 });
    });

    try {
      delete process.env.ARC_SIGSTORE_IDENTITY_TOKEN;
      delete process.env.ARC_SIGSTORE_IDENTITY_TOKEN_FILE;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_WORKFLOW_REF;

      const result = await publish({ paths: env.arc, packageDir: pkgDir });

      expect(result.success).toBe(false);
      expect(result.error).toContain("GitHub Actions OIDC");
      expect(fetchCalled).toBe(false);
    } finally {
      if (saved.ARC_SIGSTORE_IDENTITY_TOKEN === undefined) delete process.env.ARC_SIGSTORE_IDENTITY_TOKEN;
      else process.env.ARC_SIGSTORE_IDENTITY_TOKEN = saved.ARC_SIGSTORE_IDENTITY_TOKEN;
      if (saved.ARC_SIGSTORE_IDENTITY_TOKEN_FILE === undefined) delete process.env.ARC_SIGSTORE_IDENTITY_TOKEN_FILE;
      else process.env.ARC_SIGSTORE_IDENTITY_TOKEN_FILE = saved.ARC_SIGSTORE_IDENTITY_TOKEN_FILE;
      if (saved.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      if (saved.ACTIONS_ID_TOKEN_REQUEST_URL === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved.ACTIONS_ID_TOKEN_REQUEST_URL;
      if (saved.GITHUB_ACTIONS === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = saved.GITHUB_ACTIONS;
      if (saved.GITHUB_WORKFLOW_REF === undefined) delete process.env.GITHUB_WORKFLOW_REF;
      else process.env.GITHUB_WORKFLOW_REF = saved.GITHUB_WORKFLOW_REF;
    }
  });

  test("explicit unsigned official override keeps legacy payload unsigned", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);
    let registerBody: any;

    mockFetch(async (url: any, init?: RequestInit) => {
      const urlStr = String(url);

      if (urlStr.includes("/storage/upload")) {
        return new Response(
          JSON.stringify({ sha256: "any-sha", r2_key: "packages/any-sha.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/versions")) {
        if (typeof init?.body !== "string") throw new Error("expected JSON string body");
        registerBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ version_id: "uuid-unsigned" }), { status: 201 });
      }

      if (urlStr.includes("/packages/")) {
        return new Response(JSON.stringify({ namespace: "testns", name: "my-skill" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const result = await publish({
      paths: env.arc,
      packageDir: pkgDir,
      allowUnsignedOfficial: true,
      signer: async () => {
        throw new Error("signer should not be called");
      },
    });

    expect(result.success).toBe(true);
    expect(registerBody.signature_bundle_key).toBeUndefined();
    expect(registerBody.signer_identity).toBeUndefined();
    expect(registerBody.signed_at).toBeUndefined();
  });

  test("reports queued review status instead of unconditional published", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

    mockFetch(async (url: any) => {
      const urlStr = String(url);

      if (urlStr.includes("/storage/upload")) {
        return new Response(
          JSON.stringify({ sha256: "any-sha", r2_key: "packages/any-sha.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/versions")) {
        return new Response(
          JSON.stringify({
            version: { id: "version-queued" },
            submission_id: "submission-queued",
            submission: { id: "submission-queued", status: "pending_review" },
          }),
          { status: 201 },
        );
      }

      if (urlStr.includes("/packages/")) {
        return new Response(JSON.stringify({ namespace: "testns", name: "my-skill" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const result = await publish({ paths: env.arc, packageDir: pkgDir, allowUnsignedOfficial: true });
    const output = formatPublish(result);

    expect(result.success).toBe(true);
    expect(result.submissionStatus).toBe("pending_review");
    expect(result.submissionId).toBe("submission-queued");
    expect(output).toContain("queued for review");
    expect(output).toContain("submission-queued");
    expect(output).not.toContain("Published @testns/my-skill");
  });

  test("rejected publish submission fails with review comment", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

    mockFetch(async (url: any) => {
      const urlStr = String(url);

      if (urlStr.includes("/storage/upload")) {
        return new Response(
          JSON.stringify({ sha256: "any-sha", r2_key: "packages/any-sha.tar.gz", size_bytes: 100 }),
          { status: 409 },
        );
      }

      if (urlStr.includes("/versions")) {
        return new Response(
          JSON.stringify({
            version: { id: "version-rejected" },
            submission_id: "submission-rejected",
            submission: {
              id: "submission-rejected",
              status: "rejected",
              review_comment: "Capability declaration is incomplete",
            },
          }),
          { status: 201 },
        );
      }

      if (urlStr.includes("/packages/")) {
        return new Response(JSON.stringify({ namespace: "testns", name: "my-skill" }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const result = await publish({ paths: env.arc, packageDir: pkgDir, allowUnsignedOfficial: true });
    const output = formatPublish(result);

    expect(result.success).toBe(false);
    expect(result.error).toContain("rejected");
    expect(result.error).toContain("Capability declaration is incomplete");
    expect(output).toContain("Error:");
  });

  test("version exists error (409)", async () => {
    await saveSources(env.arc.sourcesPath, metafactorySource());
    const pkgDir = await createPackageDir(testDir, validManifest);

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

    const result = await publish({ paths: env.arc, packageDir: pkgDir, allowUnsignedOfficial: true });
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
