import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { join } from "path";
import { writeFile } from "fs/promises";
import {
  parsePackageRef,
  formatPackageRef,
  verifyChecksum,
  extractPackage,
  resolveFromRegistry,
  downloadPackage,
  formatQuarantineMessage,
  isQuarantineReasonCode,
  QUARANTINE_EXIT_CODE,
  QUARANTINE_REASON_CODES,
} from "../../src/lib/registry-install.js";
import type { RegistrySource } from "../../src/types.js";

function mockFetch(handler: (input: any, init?: any) => Promise<Response>): typeof fetch {
  const fn = handler as typeof fetch;
  (fn as any).preconnect = () => {};
  return fn;
}

function metafactorySource(token?: string): RegistrySource {
  return {
    name: "mf-test",
    url: "https://meta-factory.test",
    tier: "official",
    enabled: true,
    type: "metafactory",
    ...(token ? { token } : {}),
  };
}

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// parsePackageRef tests
// ---------------------------------------------------------------------------

describe("parsePackageRef", () => {
  test("parses @scope/name", () => {
    const ref = parsePackageRef("@metafactory/grove");
    expect(ref).toEqual({ scope: "metafactory", name: "grove", version: undefined });
  });

  test("parses @scope/name@version", () => {
    const ref = parsePackageRef("@metafactory/grove@1.2.3");
    expect(ref).toEqual({ scope: "metafactory", name: "grove", version: "1.2.3" });
  });

  test("parses scope/name without @", () => {
    const ref = parsePackageRef("metafactory/grove");
    expect(ref).toEqual({ scope: "metafactory", name: "grove", version: undefined });
  });

  test("returns null for git URLs", () => {
    expect(parsePackageRef("https://github.com/org/repo")).toBeNull();
    expect(parsePackageRef("git@github.com:org/repo")).toBeNull();
    expect(parsePackageRef("http://example.com/repo")).toBeNull();
  });

  test("returns null for local paths", () => {
    expect(parsePackageRef("./local/path")).toBeNull();
    expect(parsePackageRef("/absolute/path")).toBeNull();
    expect(parsePackageRef("~/home/path")).toBeNull();
  });

  test("returns null for simple names without scope", () => {
    expect(parsePackageRef("grove")).toBeNull();
    expect(parsePackageRef("my-skill")).toBeNull();
  });

  test("rejects ambiguous multi-@ version", () => {
    // @scope/name@version@evil should not parse as valid
    expect(parsePackageRef("@scope/name@1.0.0@evil")).toBeNull();
  });
});

describe("formatPackageRef", () => {
  test("formats without version", () => {
    expect(formatPackageRef({ scope: "mf", name: "grove" })).toBe("@mf/grove");
  });

  test("formats with version", () => {
    expect(formatPackageRef({ scope: "mf", name: "grove", version: "1.0.0" })).toBe("@mf/grove@1.0.0");
  });
});

// ---------------------------------------------------------------------------
// verifyChecksum tests
// ---------------------------------------------------------------------------

describe("verifyChecksum", () => {
  test("returns valid for matching hash", async () => {
    const content = "test package content";
    const filePath = join(env.paths.reposDir, "test-verify.bin");
    await writeFile(filePath, content);

    // Compute expected hash
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const expectedHash = hasher.digest("hex");

    const result = await verifyChecksum(filePath, expectedHash);
    expect(result.valid).toBe(true);
    expect(result.actual).toBe(expectedHash);
    expect(result.expected).toBe(expectedHash);
  });

  test("returns invalid for mismatched hash", async () => {
    const filePath = join(env.paths.reposDir, "test-bad.bin");
    await writeFile(filePath, "actual content");

    const result = await verifyChecksum(filePath, "0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.valid).toBe(false);
    expect(result.expected).toBe("0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.actual).not.toBe(result.expected);
  });

  test("handles case-insensitive comparison", async () => {
    const content = "case test";
    const filePath = join(env.paths.reposDir, "test-case.bin");
    await writeFile(filePath, content);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");

    const result = await verifyChecksum(filePath, hash.toUpperCase());
    expect(result.valid).toBe(true);
  });

  test("empty file has deterministic hash", async () => {
    const filePath = join(env.paths.reposDir, "test-empty.bin");
    await writeFile(filePath, "");

    const result = await verifyChecksum(filePath, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractPackage tests
// ---------------------------------------------------------------------------

describe("extractPackage", () => {
  test("fails on invalid tarball", async () => {
    const badTarball = join(env.paths.reposDir, "bad.tar.gz");
    await writeFile(badTarball, "this is not a tarball");

    const result = await extractPackage(badTarball, env.paths.reposDir, "test-pkg");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Extraction failed");
  });
});

// ---------------------------------------------------------------------------
// resolveFromRegistry tests
// ---------------------------------------------------------------------------

describe("resolveFromRegistry", () => {
  test("returns null when no metafactory sources configured", async () => {
    const result = await resolveFromRegistry(
      { scope: "foo", name: "bar" },
      [{ name: "reg", url: "https://example.com/R.yaml", tier: "community", enabled: true }],
    );
    expect(result).toBeNull();
  });

  test("resolves package with latest version", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mockFetch(async (input: any) => {
      callCount++;
      const url = typeof input === "string" ? input : input.url;
      // Per-version detail: /packages/@scope/name@version (F-501 + A-504 shape)
      if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
        return new Response(JSON.stringify({
          version: "1.2.0",
          sha256: "abc123",
          manifest_canonical: '{"name":"@metafactory/grove","version":"1.2.0"}',
          signing: { registry_signature: null, registry_key_id: null },
        }), { status: 200 });
      }
      // Package detail endpoint
      return new Response(JSON.stringify({
        namespace: "@metafactory",
        name: "grove",
        display_name: null,
        description: "",
        type: "tool",
        license: "MIT",
        latest_version: "1.2.0",
        versions: ["1.2.0", "1.1.0"],
        publisher: { display_name: "Test", tier: "official", mfa_enabled: true, github_username: null },
        sponsor: null,
        created_at: 0,
        updated_at: 0,
      }), { status: 200 });
    });

    try {
      const result = await resolveFromRegistry(
        { scope: "metafactory", name: "grove" },
        [metafactorySource()],
      );
      expect(result).not.toBeNull();
      expect(result!.version).toBe("1.2.0");
      expect(result!.sha256).toBe("abc123");
      expect(result!.downloadUrl).toContain("/api/v1/storage/download/abc123");
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves specific version when provided", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
        return new Response(JSON.stringify({
          version: "1.1.0",
          sha256: "def",
          manifest_canonical: '{"name":"@metafactory/grove","version":"1.1.0"}',
          signing: { registry_signature: null, registry_key_id: null },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        namespace: "@metafactory", name: "grove",
        display_name: null, description: "", type: "tool", license: "MIT",
        latest_version: "1.2.0", versions: ["1.2.0", "1.1.0"],
        publisher: { display_name: "Test", tier: "official", mfa_enabled: true, github_username: null },
        sponsor: null, created_at: 0, updated_at: 0,
      }), { status: 200 });
    });

    try {
      const result = await resolveFromRegistry(
        { scope: "metafactory", name: "grove", version: "1.1.0" },
        [metafactorySource()],
      );
      expect(result!.version).toBe("1.1.0");
      expect(result!.sha256).toBe("def");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not send Authorization headers (anonymous per DD-80)", async () => {
    const originalFetch = globalThis.fetch;
    const capturedAuths: (string | null)[] = [];
    globalThis.fetch = mockFetch(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      // Capture Authorization header from init (not from a reconstructed Request)
      const headers = new Headers(init?.headers);
      capturedAuths.push(headers.get("Authorization"));
      if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
        return new Response(JSON.stringify({
          version: "1.0.0",
          sha256: "abc",
          manifest_canonical: "{}",
          signing: { registry_signature: null, registry_key_id: null },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        namespace: "@test", name: "pkg",
        display_name: null, description: "", type: "skill", license: "MIT",
        latest_version: "1.0.0", versions: ["1.0.0"],
        publisher: { display_name: "T", tier: "official", mfa_enabled: true, github_username: null },
        sponsor: null, created_at: 0, updated_at: 0,
      }), { status: 200 });
    });

    try {
      await resolveFromRegistry(
        { scope: "test", name: "pkg" },
        [metafactorySource("should-not-be-sent")],
      );
      // No request should include an Authorization header
      for (const auth of capturedAuths) {
        expect(auth).toBeNull();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("propagates F-501 signing fields from version detail response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
        return new Response(JSON.stringify({
          version: "1.0.0",
          sha256: "deadbeef",
          manifest_canonical: '{"name":"@a/b","version":"1.0.0"}',
          signing: {
            registry_signature: "S".repeat(88),
            registry_key_id: "mf-reg-2026-04",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        namespace: "@a", name: "b",
        display_name: null, description: "", type: "skill", license: "MIT",
        latest_version: "1.0.0", versions: ["1.0.0"],
        publisher: { display_name: "T", tier: "official", mfa_enabled: true, github_username: null },
        sponsor: null, created_at: 0, updated_at: 0,
      }), { status: 200 });
    });

    try {
      const result = await resolveFromRegistry(
        { scope: "a", name: "b" },
        [metafactorySource()],
      );
      expect(result!.registrySignature).toBe("S".repeat(88));
      expect(result!.registryKeyId).toBe("mf-reg-2026-04");
      expect(result!.manifestCanonical).toBe('{"name":"@a/b","version":"1.0.0"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null when package not found", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Not found", { status: 404 }));

    try {
      const result = await resolveFromRegistry(
        { scope: "nobody", name: "nothing" },
        [metafactorySource()],
      );
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// downloadPackage tests
// ---------------------------------------------------------------------------

describe("downloadPackage", () => {
  test("downloads successfully and writes to temp", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(new ArrayBuffer(1024), { status: 200 }));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(true);
      expect(result.bytesDownloaded).toBe(1024);
      expect(result.tempPath).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not send Authorization header (anonymous download)", async () => {
    const originalFetch = globalThis.fetch;
    let capturedAuth: string | null = null;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("Authorization");
      return new Response(new ArrayBuffer(10), { status: 200 });
    });

    try {
      await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(capturedAuth).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns error on 401", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Access denied");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns error on 404", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Not found", { status: 404 }));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries once on network error then fails", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = mockFetch(async () => {
      attempts++;
      throw new Error("ECONNREFUSED");
    });

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(attempts).toBe(2); // original + 1 retry
      expect(result.error).toContain("network");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Issue #83: auth-gated metafactory storage endpoints (e.g. dev.meta-factory.ai)
  // require Bearer auth on /api/v1/storage/download. Anonymous installs against
  // unauthenticated registries must continue to work.
  test("sends Bearer token when source is metafactory with token", async () => {
    const originalFetch = globalThis.fetch;
    let capturedAuth: string | null = null;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("Authorization");
      return new Response(new ArrayBuffer(10), { status: 200 });
    });

    try {
      const result = await downloadPackage(
        "https://example.com/pkg.tar.gz",
        env.paths.reposDir,
        metafactorySource("test-token-abc"),
      );
      expect(result.success).toBe(true);
      expect(capturedAuth as string | null).toBe("Bearer test-token-abc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("omits Authorization header when source has no token", async () => {
    const originalFetch = globalThis.fetch;
    let capturedAuth: string | null = null;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("Authorization");
      return new Response(new ArrayBuffer(10), { status: 200 });
    });

    try {
      await downloadPackage(
        "https://example.com/pkg.tar.gz",
        env.paths.reposDir,
        metafactorySource(),
      );
      expect(capturedAuth).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("omits Authorization header for non-metafactory source even with token", async () => {
    // A registry-type source should never receive the bearer; tokens belong
    // to the metafactory API surface.
    const originalFetch = globalThis.fetch;
    let capturedAuth: string | null = null;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("Authorization");
      return new Response(new ArrayBuffer(10), { status: 200 });
    });

    try {
      const registrySource: RegistrySource = {
        name: "registry-test",
        url: "https://example.com",
        tier: "official",
        enabled: true,
        type: "registry",
        token: "should-not-be-sent",
      };
      await downloadPackage(
        "https://example.com/pkg.tar.gz",
        env.paths.reposDir,
        registrySource,
      );
      expect(capturedAuth).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("auth-gated 401 still surfaces Access denied error", async () => {
    // Even with a token in hand, the server can reject (expired/invalid).
    // Caller-facing error message stays the same.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    try {
      const result = await downloadPackage(
        "https://example.com/pkg.tar.gz",
        env.paths.reposDir,
        metafactorySource("expired-token"),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Access denied");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Defense-in-depth: if storage 302s to a presigned URL on a different
  // origin (R2/S3/CDN), the bearer token must not reach the redirect target.
  test("strips Authorization on cross-origin redirect", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = mockFetch(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const headers = new Headers(init?.headers);
      requests.push({ url, auth: headers.get("Authorization") });
      if (url.startsWith("https://meta-factory.test/")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://r2.cloudflarestorage.com/bucket/pkg.tar.gz" },
        });
      }
      return new Response(new ArrayBuffer(64), { status: 200 });
    });

    try {
      const result = await downloadPackage(
        "https://meta-factory.test/api/v1/storage/download/abc",
        env.paths.reposDir,
        metafactorySource("super-secret-token"),
      );
      expect(result.success).toBe(true);
      expect(requests).toHaveLength(2);
      // First hop (origin server) gets the bearer.
      expect(requests[0].url).toContain("meta-factory.test");
      expect(requests[0].auth).toBe("Bearer super-secret-token");
      // Second hop (cross-origin storage) MUST NOT see the bearer.
      expect(requests[1].url).toContain("r2.cloudflarestorage.com");
      expect(requests[1].auth).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("aborts after too many redirects rather than auto-following", async () => {
    // If a server keeps issuing 3xx responses, we must NOT silently fall
    // back to the runtime's default redirect-following — that would void
    // the cross-origin auth-strip contract for any hop past the cap.
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = mockFetch(async (_input: any) => {
      attempts++;
      // Bounce through a chain of cross-origin hosts forever.
      const next = `https://hop-${attempts}.example.com/x`;
      return new Response(null, {
        status: 302,
        headers: { Location: next },
      });
    });

    try {
      const result = await downloadPackage(
        "https://meta-factory.test/api/v1/storage/download/abc",
        env.paths.reposDir,
        metafactorySource("super-secret-token"),
      );
      // downloadPackage's retry loop catches the thrown "too many redirects"
      // as a generic network error after both attempts. The important part
      // is that no auto-followed fetch ever happens beyond the cap.
      expect(result.success).toBe(false);
      // Two retries × MAX_REDIRECTS hops each = 10 attempts at most.
      expect(attempts).toBeLessThanOrEqual(10);
      expect(attempts).toBeGreaterThanOrEqual(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves Authorization on same-origin redirect", async () => {
    // Internal redirect (e.g. /v1/storage/download/abc → /v2/storage/download/abc
    // on the same origin) is part of the auth surface; strip would break installs.
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = mockFetch(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const headers = new Headers(init?.headers);
      requests.push({ url, auth: headers.get("Authorization") });
      if (url.endsWith("/v1/storage/download/abc")) {
        return new Response(null, {
          status: 307,
          headers: { Location: "/v2/storage/download/abc" },
        });
      }
      return new Response(new ArrayBuffer(64), { status: 200 });
    });

    try {
      const result = await downloadPackage(
        "https://meta-factory.test/v1/storage/download/abc",
        env.paths.reposDir,
        metafactorySource("super-secret-token"),
      );
      expect(result.success).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[0].auth).toBe("Bearer super-secret-token");
      expect(requests[1].auth).toBe("Bearer super-secret-token");
      expect(requests[1].url).toContain("/v2/storage/download/abc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // -------------------------------------------------------------------------
  // arc#105 / mf#76 — quarantine reason codes (HTTP 451)
  // -------------------------------------------------------------------------

  test("451 with X-Quarantine-Reason-Code: SECURITY → quarantine result", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(
      JSON.stringify({
        error: "Unavailable for Legal Reasons",
        reason_code: "QUARANTINED_SECURITY",
        reason: "Embedded credential exfiltration discovered by trip-wire scan.",
        status: 451,
      }),
      {
        status: 451,
        headers: {
          "Content-Type": "application/json",
          "X-Quarantine-Reason-Code": "QUARANTINED_SECURITY",
        },
      },
    ));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(result.quarantine).toBeDefined();
      expect(result.quarantine!.reasonCode).toBe("QUARANTINED_SECURITY");
      expect(result.quarantine!.reason).toContain("trip-wire");
      expect(result.error).toContain("QUARANTINED_SECURITY");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("451 with each reason code variant maps through correctly", async () => {
    for (const code of QUARANTINE_REASON_CODES) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch(async () => new Response(
        JSON.stringify({ error: "Unavailable for Legal Reasons", reason_code: code, reason: "test", status: 451 }),
        { status: 451, headers: { "Content-Type": "application/json", "X-Quarantine-Reason-Code": code } },
      ));

      try {
        const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
        expect(result.success).toBe(false);
        expect(result.quarantine?.reasonCode).toBe(code);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("451 falls back to body reason_code when header missing", async () => {
    // A misconfigured edge cache might strip custom headers but preserve the
    // body. We must still surface the correct code.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(
      JSON.stringify({ error: "Unavailable for Legal Reasons", reason_code: "QUARANTINED_LEGAL", reason: "DMCA", status: 451 }),
      { status: 451, headers: { "Content-Type": "application/json" } },
    ));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.quarantine?.reasonCode).toBe("QUARANTINED_LEGAL");
      expect(result.quarantine?.reason).toBe("DMCA");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("451 with unknown reason code collapses to QUARANTINED_OTHER", async () => {
    // Forward-compat: a future server roll might add a code arc doesn't
    // know yet. Don't crash — render the safest fallback.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(
      JSON.stringify({ reason_code: "QUARANTINED_FUTURE_KIND", reason: "x", status: 451 }),
      { status: 451, headers: { "Content-Type": "application/json", "X-Quarantine-Reason-Code": "QUARANTINED_FUTURE_KIND" } },
    ));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.quarantine?.reasonCode).toBe("QUARANTINED_OTHER");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("451 with empty/non-JSON body still surfaces a quarantine result", async () => {
    // Defensive: server might return 451 with no body at all (e.g. HEAD-style
    // truncation by an upstream proxy). Header alone must drive UX.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(
      "not json at all",
      { status: 451, headers: { "X-Quarantine-Reason-Code": "QUARANTINED_POLICY" } },
    ));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(result.quarantine?.reasonCode).toBe("QUARANTINED_POLICY");
      expect(result.quarantine?.reason).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("451 without header AND without parseable body → QUARANTINED_OTHER", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("", { status: 451 }));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(result.quarantine?.reasonCode).toBe("QUARANTINED_OTHER");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("451 does NOT retry — quarantine is deliberate, not transient", async () => {
    // 401/403/404/451 are all "stop now" failures; retrying would just
    // hammer a server that already gave a final answer. Compare with the
    // existing "retries on network error" behaviour.
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = mockFetch(async () => {
      attempts++;
      return new Response("", { status: 451, headers: { "X-Quarantine-Reason-Code": "QUARANTINED_SECURITY" } });
    });

    try {
      await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// arc#105 — quarantine rendering + helpers
// ---------------------------------------------------------------------------

describe("formatQuarantineMessage", () => {
  test("SECURITY banner uses red palette when colour enabled", () => {
    const lines = formatQuarantineMessage(
      "@scope/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "trip-wire" },
      true,
    );
    expect(lines.join("\n")).toContain("SECURITY QUARANTINE");
    expect(lines.join("\n")).toContain("\x1b[41;97m"); // red bg
    expect(lines.join("\n")).toContain("trip-wire");
    expect(lines.join("\n")).toContain("QUARANTINED_SECURITY");
  });

  test("colour disabled produces plain bracketed labels — no ANSI escapes", () => {
    const lines = formatQuarantineMessage(
      "@scope/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "" },
      false,
    );
    const out = lines.join("\n");
    expect(out).toContain("[SECURITY QUARANTINE]");
    expect(out).not.toContain("\x1b[");
  });

  test("POLICY banner uses yellow palette", () => {
    const lines = formatQuarantineMessage(
      "@scope/pkg",
      { reasonCode: "QUARANTINED_POLICY", reason: "naming squat" },
      true,
    );
    expect(lines.join("\n")).toContain("POLICY QUARANTINE");
    expect(lines.join("\n")).toContain("\x1b[43;30m");
  });

  test("LEGAL banner uses neutral grey palette", () => {
    const lines = formatQuarantineMessage(
      "@scope/pkg",
      { reasonCode: "QUARANTINED_LEGAL", reason: "DMCA notice" },
      true,
    );
    const out = lines.join("\n");
    expect(out).toContain("LEGAL QUARANTINE");
    expect(out).toContain("DMCA notice");
    // Legal never wears alarm colours: must NOT use red.
    expect(out).not.toContain("\x1b[41");
  });

  test("OTHER banner uses neutral framing", () => {
    const lines = formatQuarantineMessage(
      "@scope/pkg",
      { reasonCode: "QUARANTINED_OTHER", reason: "" },
      false,
    );
    expect(lines.join("\n")).toContain("[QUARANTINED]");
    expect(lines.join("\n")).toContain("QUARANTINED_OTHER");
  });

  test("empty reason text omits the Reason: line but keeps the code", () => {
    const lines = formatQuarantineMessage(
      "@scope/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "   " }, // whitespace only
      false,
    );
    const out = lines.join("\n");
    expect(out).not.toMatch(/Reason: \s*$/m);
    expect(out).toContain("Reason code: QUARANTINED_SECURITY");
  });

  test("includes the package label in the first line", () => {
    const lines = formatQuarantineMessage(
      "@evil/pkg@1.2.3",
      { reasonCode: "QUARANTINED_SECURITY", reason: "" },
      false,
    );
    expect(lines[0]).toContain("@evil/pkg@1.2.3");
  });

  // -------------------------------------------------------------------------
  // Holly cycle-2 finding: terminal control sequence injection via reason.
  // The wire is the trust boundary. A steward-supplied reason like
  //   "\x1b[2J\x1b[HFAKE: install OK"
  // would clear the screen and repaint, defeating the warning we just
  // rendered. C0 + C1 control bytes (except \n/\t) must not survive into
  // the output stream.
  // -------------------------------------------------------------------------
  test("strips ESC-bracket sequences from reason text", () => {
    const lines = formatQuarantineMessage(
      "@evil/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "\x1b[2J\x1b[Hpwn'd by steward" },
      false,
    );
    const out = lines.join("\n");
    expect(out).not.toContain("\x1b[");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("pwn'd by steward");
  });

  test("strips OSC sequences and bell from reason", () => {
    const lines = formatQuarantineMessage(
      "@evil/pkg",
      { reasonCode: "QUARANTINED_LEGAL", reason: "\x1b]0;FAKE WINDOW TITLE\x07trailing prose" },
      false,
    );
    const out = lines.join("\n");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).toContain("trailing prose");
  });

  test("strips carriage return so a payload cannot overwrite prior line", () => {
    const lines = formatQuarantineMessage(
      "@evil/pkg",
      { reasonCode: "QUARANTINED_POLICY", reason: "real reason\rOK" },
      false,
    );
    const out = lines.join("\n");
    expect(out).not.toContain("\r");
  });

  test("strips C1 high-control bytes (0x80-0x9F)", () => {
    const lines = formatQuarantineMessage(
      "@evil/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "before\x9bafter" },
      false,
    );
    const out = lines.join("\n");
    expect(out).not.toContain("\x9b");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("preserves newline and tab — those are legitimate prose punctuation", () => {
    const lines = formatQuarantineMessage(
      "@evil/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "line one\nline two\tcol two" },
      false,
    );
    const out = lines.join("\n");
    expect(out).toContain("line one\nline two");
    expect(out).toContain("\tcol two");
  });

  test("ANSI banner colours from the renderer itself still render — sanitisation only touches reason", () => {
    // Defensive: make sure sanitisation didn't accidentally strip the
    // banner's own escape sequences. The threat is the wire input, not
    // the renderer's own palette.
    const lines = formatQuarantineMessage(
      "@evil/pkg",
      { reasonCode: "QUARANTINED_SECURITY", reason: "" },
      true,
    );
    expect(lines.join("\n")).toContain("\x1b[41;97m");
  });
});

describe("isQuarantineReasonCode", () => {
  test("accepts every code in the closed enum", () => {
    for (const code of QUARANTINE_REASON_CODES) {
      expect(isQuarantineReasonCode(code)).toBe(true);
    }
  });

  test("rejects unknown strings, numbers, null, undefined", () => {
    expect(isQuarantineReasonCode("QUARANTINED_FOO")).toBe(false);
    expect(isQuarantineReasonCode("")).toBe(false);
    expect(isQuarantineReasonCode(0)).toBe(false);
    expect(isQuarantineReasonCode(null)).toBe(false);
    expect(isQuarantineReasonCode(undefined)).toBe(false);
    expect(isQuarantineReasonCode({ reason_code: "QUARANTINED_SECURITY" })).toBe(false);
  });
});

describe("QUARANTINE_EXIT_CODE", () => {
  test("is 4 — distinct from generic failure (1) and reserved POSIX codes", () => {
    expect(QUARANTINE_EXIT_CODE).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Adversarial regression tests (DD-79)
// ---------------------------------------------------------------------------

describe("adversarial: SHA-256 tamper detection", () => {
  test("rejects install when registry returns tampered hash", async () => {
    // Scenario: registry is compromised and returns a different SHA-256
    // than what the artifact actually contains. arc must reject because
    // it recomputes the hash from the downloaded bytes independently.
    const realContent = "legitimate package content";
    const filePath = join(env.paths.reposDir, "tampered-hash.tar.gz");
    await writeFile(filePath, realContent);

    // Registry claims a hash that doesn't match the actual file
    const tamperedHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const result = await verifyChecksum(filePath, tamperedHash);
    expect(result.valid).toBe(false);
    expect(result.expected).toBe(tamperedHash);
    expect(result.actual).not.toBe(tamperedHash);
  });

  test("rejects when artifact is replaced with different content but same size", async () => {
    // Scenario: attacker replaces artifact with malicious payload of the
    // same byte length. SHA-256 must catch this.
    const originalContent = "AAAA"; // 4 bytes
    const maliciousContent = "BBBB"; // 4 bytes — same length

    // Compute hash of original
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(originalContent);
    const originalHash = hasher.digest("hex");

    // Write the malicious content but verify against original hash
    const filePath = join(env.paths.reposDir, "swapped-same-size.bin");
    await writeFile(filePath, maliciousContent);

    const result = await verifyChecksum(filePath, originalHash);
    expect(result.valid).toBe(false);
    expect(result.actual).not.toBe(originalHash);
  });

  test("rejects truncated artifact", async () => {
    // Scenario: artifact is truncated mid-transfer. The partial file has
    // a different SHA-256 than the complete artifact.
    const fullContent = "full package content with many bytes of data";
    const truncatedContent = "full pack"; // cut mid-stream

    // Hash of the full content is what the registry advertises
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(fullContent);
    const fullHash = hasher.digest("hex");

    // Write truncated version and verify against full hash
    const filePath = join(env.paths.reposDir, "truncated.tar.gz");
    await writeFile(filePath, truncatedContent);

    const result = await verifyChecksum(filePath, fullHash);
    expect(result.valid).toBe(false);
    expect(result.actual).not.toBe(fullHash);
  });

  test("rejects artifact with appended bytes", async () => {
    // Scenario: attacker appends malicious payload to a valid artifact
    const originalContent = "valid package";
    const tamperedContent = "valid package\x00MALICIOUS_PAYLOAD";

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(originalContent);
    const originalHash = hasher.digest("hex");

    const filePath = join(env.paths.reposDir, "appended.tar.gz");
    await writeFile(filePath, tamperedContent);

    const result = await verifyChecksum(filePath, originalHash);
    expect(result.valid).toBe(false);
  });
});

describe("adversarial: download path error handling", () => {
  test("download returns error on server 500 after retries", async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = mockFetch(async () => {
      attempts++;
      return new Response("Internal Server Error", { status: 500 });
    });

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain("500");
      expect(attempts).toBe(2); // original + 1 retry
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("download does not write partial file on failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Forbidden", { status: 403 }));

    try {
      const result = await downloadPackage("https://example.com/pkg.tar.gz", env.paths.reposDir);
      expect(result.success).toBe(false);
      // No tempPath should be returned on failure
      expect(result.tempPath).toBeUndefined();
      // Also verify no arc-download-* files leaked to disk
      const { readdirSync } = await import("fs");
      const leaked = readdirSync(env.paths.reposDir).filter((f: string) => f.startsWith("arc-download-"));
      expect(leaked).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("adversarial: extract path integrity", () => {
  test("extraction cleans up on invalid tarball — no partial files left", async () => {
    const badTarball = join(env.paths.reposDir, "adversarial-bad.tar.gz");
    await writeFile(badTarball, "this is not a valid tarball at all");

    const extractDir = "adversarial-test-pkg";
    const result = await extractPackage(badTarball, env.paths.reposDir, extractDir);

    expect(result.success).toBe(false);
    // The target directory should be cleaned up after failed extraction
    const { existsSync } = await import("fs");
    expect(existsSync(join(env.paths.reposDir, extractDir))).toBe(false);
  });

  test("extraction rejects archive without manifest", async () => {
    // Create a valid tarball but without arc-manifest.yaml
    const tarDir = join(env.paths.reposDir, "no-manifest-src");
    const { mkdir: mkdirFs } = await import("fs/promises");
    await mkdirFs(tarDir, { recursive: true });
    await writeFile(join(tarDir, "README.md"), "# No manifest here");

    const tarball = join(env.paths.reposDir, "no-manifest.tar.gz");
    Bun.spawnSync(["tar", "czf", tarball, "-C", env.paths.reposDir, "no-manifest-src"], {
      stdout: "pipe", stderr: "pipe",
    });

    const result = await extractPackage(tarball, env.paths.reposDir, "no-manifest-pkg");
    expect(result.success).toBe(false);
    expect(result.error).toContain("arc-manifest.yaml");
  });
});
