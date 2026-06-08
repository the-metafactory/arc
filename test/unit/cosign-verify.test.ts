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
    const result = await downloadSigstoreBundle("https://reg.test/bundle", env.arc.reposDir);
    expect(result.path).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("returns error on 404", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () => new Response("not found", { status: 404 }));
    const result = await downloadSigstoreBundle("https://reg.test/bundle", env.arc.reposDir);
    expect(result.error).toMatch(/not found/i);
    expect(result.path).toBeUndefined();
  });

  test("returns error on network failure (never throws)", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () => {
      throw new Error("boom");
    });
    const result = await downloadSigstoreBundle("https://reg.test/bundle", env.arc.reposDir);
    expect(result.error).toBeDefined();
    expect(result.path).toBeUndefined();
  });

  // arc#207: the registry's GET /storage/bundle/:sha256 is requireAuth()'d
  // ("same access level as tarball download") — the old anonymous-per-DD-80
  // behavior 401'd every signed install once the identity gap (#303) was
  // fixed and the download line became reachable.
  test("sends Authorization when the metafactory source has a token (#207)", async () => {
    env = await createTestEnv();
    let authSeen: string | null | undefined;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      authSeen = new Headers(init?.headers).get("Authorization");
      return new Response("{}", { status: 200 });
    });
    await downloadSigstoreBundle("https://reg.test/bundle", env.arc.reposDir, {
      ...source(),
      token: "test-token",
    });
    expect(authSeen).toBe("Bearer test-token");
  });

  test("stays anonymous when no source is provided", async () => {
    env = await createTestEnv();
    let authSeen: string | null | undefined;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      authSeen = new Headers(init?.headers).get("Authorization");
      return new Response("{}", { status: 200 });
    });
    await downloadSigstoreBundle("https://reg.test/bundle", env.arc.reposDir);
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
      tempDir: env.arc.reposDir,
    });
    expect(result.verified).toBeNull();
    expect(result.reason).toMatch(/not sigstore-signed/i);
  });

  // soma#303: a signed bundle whose registry record lacks signer_identity is
  // a registry DATA gap, not a tampered artifact. Hard-failing bricked every
  // signed install when the registry never populated the field. Degrade to
  // verified=null (warn path; --strict-signing still refuses on official
  // tier) and offer ARC_SIGSTORE_EXPECTED_IDENTITY to verify anyway.
  test("verified=null (degraded) when signature_bundle_key present but signer_identity missing", async () => {
    env = await createTestEnv();
    delete process.env.ARC_SIGSTORE_EXPECTED_IDENTITY;
    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: { signature_bundle_key: "packages/abc.bundle", signer_identity: null },
      artifactPath: "/tmp/fake.tgz",
      tempDir: env.arc.reposDir,
    });
    expect(result.verified).toBeNull();
    expect(result.reason).toMatch(/signer_identity/i);
    expect(result.reason).toMatch(/ARC_SIGSTORE_EXPECTED_IDENTITY/);
  });

  test("ARC_SIGSTORE_EXPECTED_IDENTITY enables full verification when registry omits identity", async () => {
    env = await createTestEnv();
    const expected =
      "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main";
    process.env.ARC_SIGSTORE_EXPECTED_IDENTITY = expected;
    try {
      globalThis.fetch = mockFetch(async () => new Response("{}", { status: 200 }));
      let seenIdentity: string | undefined;
      const result = await verifyPackageSigstore({
        source: source(),
        sha256: "abc",
        signing: { signature_bundle_key: "packages/abc.bundle", signer_identity: null },
        artifactPath: "/tmp/fake.tgz",
        tempDir: env.arc.reposDir,
        verifier: async (_artifact, _bundle, identity) => {
          seenIdentity = identity;
          return { valid: true };
        },
      });
      expect(seenIdentity).toBe(expected);
      expect(result.verified).toBe(true);
      expect(result.reason).toMatch(/operator-supplied/i);
    } finally {
      delete process.env.ARC_SIGSTORE_EXPECTED_IDENTITY;
    }
  });

  test("ARC_SIGSTORE_EXPECTED_IDENTITY mismatch still fails verification", async () => {
    env = await createTestEnv();
    process.env.ARC_SIGSTORE_EXPECTED_IDENTITY =
      "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main";
    try {
      globalThis.fetch = mockFetch(async () => new Response("{}", { status: 200 }));
      const result = await verifyPackageSigstore({
        source: source(),
        sha256: "abc",
        signing: { signature_bundle_key: "packages/abc.bundle", signer_identity: null },
        artifactPath: "/tmp/fake.tgz",
        tempDir: env.arc.reposDir,
        verifier: async () => ({ valid: false, error: "no matching signatures" }),
      });
      expect(result.verified).toBe(false);
    } finally {
      delete process.env.ARC_SIGSTORE_EXPECTED_IDENTITY;
    }
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
      tempDir: env.arc.reposDir,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/bundle/i);
  });

  test("verified=true when injected verifier returns valid", async () => {
    env = await createTestEnv();
    const bundleBody = '{"mediaType":"application/vnd.dev.sigstore.bundle+json"}';
    globalThis.fetch = mockFetch(async () => new Response(bundleBody, { status: 200 }));

    // Create a real artifact file so verifier receives a valid path
    const artifactPath = join(env.arc.reposDir, "artifact.tgz");
    await writeFile(artifactPath, "fake-contents");

    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: {
        signature_bundle_key: "packages/abc.bundle",
        signer_identity: "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main",
      },
      artifactPath,
      tempDir: env.arc.reposDir,
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
    const artifactPath = join(env.arc.reposDir, "artifact.tgz");
    await writeFile(artifactPath, "fake");

    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: {
        signature_bundle_key: "packages/abc.bundle",
        signer_identity: "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main",
      },
      artifactPath,
      tempDir: env.arc.reposDir,
      verifier: async () => ({ valid: false, error: "signature mismatch" }),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signature mismatch/i);
  });

  // #216: a verifier that THROWS (e.g. cosign has no binary for this
  // platform/arch, so detectPlatform throws) is a verification *capability*
  // gap, not a tampered artifact. It must degrade to verified=null (warn
  // path; --strict-signing still refuses on official tier), matching the
  // unsigned and soma#303 contracts — never propagate the throw and abort
  // the whole install.
  test("verified=null when the verifier throws (platform/binary unavailable)", async () => {
    env = await createTestEnv();
    globalThis.fetch = mockFetch(async () =>
      new Response('{"mediaType":"application/vnd.dev.sigstore.bundle+json"}', { status: 200 }),
    );
    const artifactPath = join(env.arc.reposDir, "artifact.tgz");
    await writeFile(artifactPath, "fake");

    const result = await verifyPackageSigstore({
      source: source(),
      sha256: "abc",
      signing: {
        signature_bundle_key: "packages/abc.bundle",
        signer_identity: "https://github.com/owner/repo/.github/workflows/publish.yml@refs/heads/main",
      },
      artifactPath,
      tempDir: env.arc.reposDir,
      verifier: async () => {
        throw new Error("Unsupported platform: sunos. cosign binaries are available for: darwin, linux, windows");
      },
    });
    expect(result.verified).toBeNull();
    expect(result.reason).toMatch(/unavailable/i);
    expect(result.reason).toMatch(/Unsupported platform/);
  });

  test("TRUSTED_OIDC_ISSUER is GitHub Actions (OQ-14 scope)", () => {
    expect(TRUSTED_OIDC_ISSUER).toBe("https://token.actions.githubusercontent.com");
  });
});
