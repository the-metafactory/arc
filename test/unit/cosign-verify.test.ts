import { describe, test, expect, afterEach } from "bun:test";
import {
  downloadSigstoreBundle,
  verifyPackageSigstore,
  TRUSTED_OIDC_ISSUER,
} from "../../src/lib/cosign-verify.js";
import type { RegistrySource } from "../../src/types.js";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { writeFile } from "fs/promises";
import { join } from "path";

function mockFetch(handler: (input: any, init?: any) => Promise<Response>): typeof fetch {
  const fn = handler as typeof fetch;
  (fn as any).preconnect = () => {};
  return fn;
}

function source(url = "https://reg.test"): RegistrySource {
  return { name: "mf", url, tier: "official", enabled: true, type: "metafactory" };
}

const ORIGINAL_FETCH = globalThis.fetch;
let env: TestEnv;

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (env) await env.cleanup();
});

// ---------------------------------------------------------------------------
// downloadSigstoreBundle
// ---------------------------------------------------------------------------

describe("downloadSigstoreBundle", () => {
  test("writes the bundle to temp and returns the path", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () =>
      new Response('{"mediaType":"application/vnd.dev.sigstore.bundle+json;version=0.1"}', {
        status: 200,
      }),
    );
    const result = await downloadSigstoreBundle("https://reg.test/bundle", env.paths.reposDir);
    expect(result.path).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("returns error on 404", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () => new Response("not found", { status: 404 }));
    const result = await downloadSigstoreBundle("https://reg.test/bundle", env.paths.reposDir);
    expect(result.error).toMatch(/not found/i);
    expect(result.path).toBeUndefined();
  });

  test("returns error on network failure (never throws)", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () => {
      throw new Error("boom");
    });
    const result = await downloadSigstoreBundle("https://reg.test/bundle", env.paths.reposDir);
    expect(result.error).toBeDefined();
    expect(result.path).toBeUndefined();
  });

  test("does not send Authorization header (anonymous per DD-80)", async () => {
    env = await createTestEnv();
    let authSeen: string | null | undefined;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      authSeen = new Headers(init?.headers).get("Authorization");
      return new Response("{}", { status: 200 });
    });
    await downloadSigstoreBundle("https://reg.test/bundle", env.paths.reposDir);
    expect(authSeen).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyPackageSigstore — orchestrator, verifier injected for test isolation
// ---------------------------------------------------------------------------

describe("verifyPackageSigstore", () => {
  test("verified=null when signature_bundle_key is null (legacy/unsigned)", async () => {
    env = await createTestEnv();
    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: { signature_bundle_key: null, signer_identity: null },
      artifactPath: "/tmp/fake.tgz",
      tempDir: env.paths.reposDir,
    });
    expect(result.verified).toBeNull();
    expect(result.reason).toMatch(/not sigstore-signed/i);
  });

  test("verified=false when signature_bundle_key present but signer_identity missing", async () => {
    env = await createTestEnv();
    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: { signature_bundle_key: "packages/abc.bundle", signer_identity: null },
      artifactPath: "/tmp/fake.tgz",
      tempDir: env.paths.reposDir,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signer_identity/i);
  });

  test("verified=false when bundle download fails", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () => new Response("", { status: 503 }));
    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: {
        signature_bundle_key: "packages/abc.bundle",
        signer_identity: "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main",
      },
      artifactPath: "/tmp/fake.tgz",
      tempDir: env.paths.reposDir,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/bundle/i);
  });

  test("verified=true when injected verifier returns valid", async () => {
    env = await createTestEnv();
    const bundleBody = '{"mediaType":"application/vnd.dev.sigstore.bundle+json"}';
    globalThis.fetch = mockFetch(async () => new Response(bundleBody, { status: 200 }));

    // Create a real artifact file so verifier receives a valid path
    const artifactPath = join(env.paths.reposDir, "artifact.tgz");
    await writeFile(artifactPath, "fake-contents");

    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: {
        signature_bundle_key: "packages/abc.bundle",
        signer_identity: "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main",
      },
      artifactPath,
      tempDir: env.paths.reposDir,
      verifier: async (artifact: string, bundle: string, identity: string, issuer: string) => {
        expect(artifact).toBe(artifactPath);
        expect(bundle).toMatch(/\.bundle$/);
        expect(identity).toContain("publish.yml");
        expect(issuer).toBe(TRUSTED_OIDC_ISSUER);
        return { valid: true, output: "ok" };
      },
    });
    expect(result.verified).toBe(true);
  });

  test("verified=false when injected verifier returns invalid (tampered artifact)", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () =>
      new Response('{"mediaType":"application/vnd.dev.sigstore.bundle+json"}', { status: 200 }),
    );
    const artifactPath = join(env.paths.reposDir, "artifact.tgz");
    await writeFile(artifactPath, "fake");

    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: {
        signature_bundle_key: "packages/abc.bundle",
        signer_identity: "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main",
      },
      artifactPath,
      tempDir: env.paths.reposDir,
      verifier: async () => ({ valid: false, error: "signature mismatch" }),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signature mismatch/i);
  });

  test("TRUSTED_OIDC_ISSUER is GitHub Actions (OQ-14 scope)", () => {
    expect(TRUSTED_OIDC_ISSUER).toBe("https://token.actions.githubusercontent.com");
  });
});
