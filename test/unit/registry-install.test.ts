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
      if (url.includes("/versions")) {
        return new Response(JSON.stringify({
          versions: [{ version: "1.2.0", sha256: "abc123" }, { version: "1.1.0", sha256: "def456" }],
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
      if (url.includes("/versions")) {
        return new Response(JSON.stringify({
          versions: [{ version: "1.2.0", sha256: "abc" }, { version: "1.1.0", sha256: "def" }],
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
      if (url.includes("/versions")) {
        return new Response(JSON.stringify({
          versions: [{ version: "1.0.0", sha256: "abc" }],
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
});
