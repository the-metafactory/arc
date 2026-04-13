import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  mapApiPackageToRegistryEntry,
  fetchMetafactoryRegistry,
  fetchMetafactoryPackageDetail,
} from "../../src/lib/metafactory-api.js";
import type {
  MetafactoryPackageListItem,
  MetafactoryPackageListResponse,
  RegistrySource,
} from "../../src/types.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Mapping tests (T-5.1)
// ---------------------------------------------------------------------------

function sampleApiPackage(overrides?: Partial<MetafactoryPackageListItem>): MetafactoryPackageListItem {
  return {
    namespace: "@mellanon",
    name: "research",
    display_name: "Research",
    description: "Multi-agent parallel research",
    type: "skill",
    license: "MIT",
    latest_version: "1.2.0",
    publisher: { display_name: "Andreas", tier: "trusted", mfa_enabled: true },
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

describe("mapApiPackageToRegistryEntry", () => {
  test("maps all fields correctly", () => {
    const { entry, artifactType } = mapApiPackageToRegistryEntry(sampleApiPackage());
    expect(entry.name).toBe("@mellanon/research");
    expect(entry.description).toBe("Multi-agent parallel research");
    expect(entry.author).toBe("Andreas");
    expect(entry.version).toBe("1.2.0");
    expect(entry.status).toBe("shipped");
    expect(artifactType).toBe("skill");
  });

  test("handles missing optional fields", () => {
    const { entry } = mapApiPackageToRegistryEntry(sampleApiPackage({
      description: null,
      latest_version: null,
      publisher: { display_name: null, tier: null, mfa_enabled: false },
    }));
    expect(entry.description).toBe("");
    expect(entry.version).toBe("0.0.0");
    expect(entry.author).toBe("unknown");
  });

  test("maps tool type correctly", () => {
    const { artifactType } = mapApiPackageToRegistryEntry(sampleApiPackage({ type: "tool" }));
    expect(artifactType).toBe("tool");
  });

  test("maps agent type correctly", () => {
    const { artifactType } = mapApiPackageToRegistryEntry(sampleApiPackage({ type: "agent" }));
    expect(artifactType).toBe("agent");
  });

  test("maps prompt type correctly", () => {
    const { artifactType } = mapApiPackageToRegistryEntry(sampleApiPackage({ type: "prompt" }));
    expect(artifactType).toBe("prompt");
  });

  test("maps unknown type to skill", () => {
    const { artifactType } = mapApiPackageToRegistryEntry(sampleApiPackage({ type: "unknown-future-type" }));
    expect(artifactType).toBe("skill");
  });
});

// ---------------------------------------------------------------------------
// fetchMetafactoryRegistry tests (T-5.2 + T-5.4)
// ---------------------------------------------------------------------------

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

function mockFetchResponse(packages: MetafactoryPackageListItem[], total?: number): Response {
  const body: MetafactoryPackageListResponse = {
    packages,
    total: total ?? packages.length,
    page: 1,
    per_page: 100,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create a fetch mock that satisfies Bun's typeof fetch (includes preconnect) */
function mockFetch(handler: (input: any, init?: any) => Promise<Response>): typeof fetch {
  const fn = handler as typeof fetch;
  (fn as any).preconnect = () => {};
  return fn;
}

describe("fetchMetafactoryRegistry", () => {
  test("returns RegistryConfig from API response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => mockFetchResponse([sampleApiPackage()]));

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath);
      expect(result).not.toBeNull();
      expect(result!.registry.skills.length).toBe(1);
      expect(result!.registry.skills[0].name).toBe("@mellanon/research");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not send Authorization header even when token configured (anonymous per DD-80)", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      capturedHeaders = new Headers(init?.headers);
      return mockFetchResponse([]);
    });

    try {
      await fetchMetafactoryRegistry(metafactorySource("my-secret-token"), env.paths.cachePath, true);
      expect(capturedHeaders?.get("Authorization")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Internal Server Error", { status: 500 }));

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath, true);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => { throw new Error("ECONNREFUSED"); });

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath, true);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("caches result and reads from cache", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = mockFetch(async () => {
      fetchCount++;
      return mockFetchResponse([sampleApiPackage()]);
    });

    try {
      // First call fetches
      const result1 = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath, true);
      expect(result1).not.toBeNull();
      expect(fetchCount).toBe(1);

      // Second call uses cache (not forceRefresh)
      const result2 = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath);
      expect(result2).not.toBeNull();
      expect(fetchCount).toBe(1); // no additional fetch
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("places tools in registry.tools", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => mockFetchResponse([sampleApiPackage({ type: "tool" })]));

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath, true);
      expect(result!.registry.tools.length).toBe(1);
      expect(result!.registry.skills.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null and logs on 401 (token expired)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource("expired-token"), env.paths.cachePath, true);
      // Returns null (or stale cache) -- not a crash
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on 429 (rate limited)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("Too Many Requests", { status: 429 }));

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath, true);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on invalid JSON response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response("<html>not json</html>", { status: 200 }));

    try {
      const result = await fetchMetafactoryRegistry(metafactorySource(), env.paths.cachePath, true);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// fetchMetafactoryPackageDetail tests (T-5.2 extension)
// ---------------------------------------------------------------------------

describe("fetchMetafactoryPackageDetail", () => {
  test("returns parsed detail on success", async () => {
    const detail = {
      namespace: "@mellanon",
      name: "research",
      display_name: "Research",
      description: "Multi-agent research",
      type: "skill",
      license: "MIT",
      latest_version: "1.2.0",
      versions: ["1.2.0", "1.1.0"],
      publisher: { display_name: "Andreas", tier: "trusted", mfa_enabled: true, github_username: "mellanon" },
      sponsor: null,
      created_at: 1700000000,
      updated_at: 1700000000,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify(detail), { status: 200 }));

    try {
      const result = await fetchMetafactoryPackageDetail(metafactorySource(), "@mellanon", "research");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("research");
      expect(result!.versions).toEqual(["1.2.0", "1.1.0"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on 404", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response('{"error":"Not found"}', { status: 404 }));

    try {
      const result = await fetchMetafactoryPackageDetail(metafactorySource(), "@mellanon", "nonexistent");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns null on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => { throw new Error("ECONNREFUSED"); });

    try {
      const result = await fetchMetafactoryPackageDetail(metafactorySource(), "@mellanon", "research");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
