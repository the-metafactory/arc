import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { logout } from "../../src/commands/logout.js";
import { saveSources, loadSources } from "../../src/lib/sources.js";
import type { SourcesConfig } from "../../src/types.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

function metafactorySource(token?: string): SourcesConfig {
  return {
    sources: [{
      name: "mf-test",
      url: "https://meta-factory.ai",
      tier: "official",
      enabled: true,
      type: "metafactory",
      ...(token ? { token } : {}),
    }],
  };
}

function registrySource(): SourcesConfig {
  return {
    sources: [{
      name: "my-registry",
      url: "https://example.com/REG.yaml",
      tier: "community",
      enabled: true,
    }],
  };
}

describe("logout - source finding", () => {
  test("returns error when no metafactory source configured", async () => {
    await saveSources(env.paths.sourcesPath, registrySource());
    const result = await logout({ paths: env.paths });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No metafactory source configured");
  });

  test("returns error when --source name not found", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource("token"));
    const result = await logout({ paths: env.paths, sourceName: "nonexistent" });
    expect(result.success).toBe(false);
    expect(result.error).toContain('"nonexistent" not found');
  });

  test("returns error when source is type registry", async () => {
    await saveSources(env.paths.sourcesPath, registrySource());
    const result = await logout({ paths: env.paths, sourceName: "my-registry" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("registry");
    expect(result.error).toContain("not \"metafactory\"");
  });
});

describe("logout - token removal", () => {
  test("returns error when not logged in", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource());
    const result = await logout({ paths: env.paths });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not logged in");
  });

  test("removes token on success", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource("my-secret-token"));
    const result = await logout({ paths: env.paths });
    expect(result.success).toBe(true);
    expect(result.sourceName).toBe("mf-test");

    // Verify token removed from disk
    const config = await loadSources(env.paths.sourcesPath);
    const source = config.sources.find((s) => s.name === "mf-test");
    expect(source).toBeDefined();
    expect(source!.token).toBeUndefined();
  });

  test("source still exists after logout", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource("token-to-remove"));
    await logout({ paths: env.paths });

    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources.find((s) => s.name === "mf-test")).toBeDefined();
  });

  test("other sources unchanged", async () => {
    const config: SourcesConfig = {
      sources: [
        { name: "mf-test", url: "https://meta-factory.ai", tier: "official", enabled: true, type: "metafactory", token: "remove-me" },
        { name: "other", url: "https://example.com/R.yaml", tier: "community", enabled: true },
      ],
    };
    await saveSources(env.paths.sourcesPath, config);
    await logout({ paths: env.paths });

    const reloaded = await loadSources(env.paths.sourcesPath);
    expect(reloaded.sources).toHaveLength(2);
    expect(reloaded.sources[1].name).toBe("other");
    expect(reloaded.sources[1].url).toBe("https://example.com/R.yaml");
  });
});
