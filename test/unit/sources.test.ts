import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  createDefaultSources,
  formatSourceList,
  validateSource,
  getSourceType,
} from "../../src/lib/sources.js";
import type { SourcesConfig, RegistrySource } from "../../src/types.js";
import YAML from "yaml";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("loadSources", () => {
  test("creates default sources.yaml if missing", async () => {
    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0].name).toBe("metafactory");
    expect(config.sources[0].url).toBe("https://meta-factory.ai");
    expect(config.sources[0].type).toBe("metafactory");
    expect(config.sources[0].tier).toBe("official");
    expect(config.sources[0].enabled).toBe(true);
  });

  test("loads valid sources.yaml", async () => {
    const custom: SourcesConfig = {
      sources: [
        { name: "hub-a", url: "https://example.com/a.yaml", tier: "official", enabled: true },
        { name: "hub-b", url: "https://example.com/b.yaml", tier: "community", enabled: false },
      ],
    };
    await Bun.write(env.paths.sourcesPath, YAML.stringify(custom));

    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources).toHaveLength(2);
    expect(config.sources[0].name).toBe("hub-a");
    expect(config.sources[1].enabled).toBe(false);
  });

  test("returns defaults for invalid yaml (no sources array)", async () => {
    await Bun.write(env.paths.sourcesPath, "foo: bar\n");

    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0].name).toBe("metafactory");
  });

  test("returns defaults for empty file", async () => {
    await Bun.write(env.paths.sourcesPath, "");

    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources).toHaveLength(1);
  });
});

describe("saveSources", () => {
  test("writes valid yaml", async () => {
    const config: SourcesConfig = {
      sources: [
        { name: "test", url: "https://example.com/reg.yaml", tier: "custom", enabled: true },
      ],
    };
    await saveSources(env.paths.sourcesPath, config);

    const reloaded = await loadSources(env.paths.sourcesPath);
    expect(reloaded.sources).toHaveLength(1);
    expect(reloaded.sources[0].name).toBe("test");
  });
});

describe("addSource", () => {
  test("adds a new source", () => {
    const config = createDefaultSources();
    addSource(config, {
      name: "new-hub",
      url: "https://example.com/new.yaml",
      tier: "official",
      enabled: true,
    });
    expect(config.sources).toHaveLength(2);
    expect(config.sources[1].name).toBe("new-hub");
  });

  test("throws on duplicate name", () => {
    const config = createDefaultSources();
    expect(() =>
      addSource(config, {
        name: "metafactory",
        url: "https://example.com/dup.yaml",
        tier: "community",
        enabled: true,
      })
    ).toThrow('already exists');
  });
});

describe("removeSource", () => {
  test("removes existing source", () => {
    const config = createDefaultSources();
    removeSource(config, "metafactory");
    expect(config.sources).toHaveLength(0);
  });

  test("throws for non-existent source", () => {
    const config = createDefaultSources();
    expect(() => removeSource(config, "nope")).toThrow('not found');
  });
});

describe("formatSourceList", () => {
  test("formats source list with type", () => {
    const config = createDefaultSources();
    const output = formatSourceList(config);
    expect(output).toContain("metafactory");
    expect(output).toContain("[official]");
    expect(output).toContain("(metafactory)");
    expect(output).toContain("(enabled)");
  });

  test("handles empty sources", () => {
    const output = formatSourceList({ sources: [] });
    expect(output).toContain("No sources configured");
  });

  test("shows registry type for legacy sources", () => {
    const config: SourcesConfig = {
      sources: [{ name: "legacy", url: "https://example.com/REG.yaml", tier: "community", enabled: true }],
    };
    const output = formatSourceList(config);
    expect(output).toContain("(registry)");
  });

  test("never shows token in output", () => {
    const config: SourcesConfig = {
      sources: [{
        name: "auth", url: "https://meta-factory.ai",
        tier: "official", enabled: true, type: "metafactory",
        token: "secret-bearer-token-abc123",
      }],
    };
    const output = formatSourceList(config);
    expect(output).not.toContain("secret-bearer-token-abc123");
    expect(output).not.toContain("token");
  });
});

describe("getSourceType", () => {
  test("returns explicit type when present", () => {
    expect(getSourceType({ name: "x", url: "y", tier: "official", enabled: true, type: "metafactory" }))
      .toBe("metafactory");
  });

  test("returns registry when type is explicitly registry", () => {
    expect(getSourceType({ name: "x", url: "y", tier: "official", enabled: true, type: "registry" }))
      .toBe("registry");
  });

  test("defaults to registry when type is absent", () => {
    expect(getSourceType({ name: "x", url: "y", tier: "official", enabled: true }))
      .toBe("registry");
  });
});

describe("validateSource", () => {
  test("accepts explicit registry type", () => {
    const result = validateSource({
      name: "test", url: "https://example.com/REG.yaml",
      tier: "community", enabled: true, type: "registry",
    });
    expect(result.valid).toBe(true);
  });

  test("accepts metafactory type with valid HTTPS URL", () => {
    const result = validateSource({
      name: "mf", url: "https://meta-factory.ai",
      tier: "official", enabled: true, type: "metafactory",
    });
    expect(result.valid).toBe(true);
  });

  test("accepts source without type field (defaults to registry)", () => {
    const result = validateSource({
      name: "legacy", url: "https://example.com/REGISTRY.yaml",
      tier: "community", enabled: true,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects invalid type value", () => {
    const result = validateSource({
      name: "bad", url: "https://example.com",
      tier: "community", enabled: true, type: "foobar" as any,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid source type");
    expect(result.error).toContain("foobar");
  });

  test("rejects HTTP URL for metafactory", () => {
    const result = validateSource({
      name: "bad", url: "http://meta-factory.ai",
      tier: "official", enabled: true, type: "metafactory",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  test("rejects .yaml path for metafactory", () => {
    const result = validateSource({
      name: "bad", url: "https://example.com/REGISTRY.yaml",
      tier: "official", enabled: true, type: "metafactory",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("base URL");
    expect(result.error).toContain("--type registry");
  });

  test("rejects .yml path for metafactory", () => {
    const result = validateSource({
      name: "bad", url: "https://example.com/reg.yml",
      tier: "official", enabled: true, type: "metafactory",
    });
    expect(result.valid).toBe(false);
  });

  test("accepts YAML path for registry type", () => {
    const result = validateSource({
      name: "ok", url: "https://example.com/REGISTRY.yaml",
      tier: "community", enabled: true, type: "registry",
    });
    expect(result.valid).toBe(true);
  });
});

describe("addSource with validation", () => {
  test("rejects invalid metafactory source via addSource", () => {
    const config = createDefaultSources();
    expect(() =>
      addSource(config, {
        name: "bad-mf", url: "http://example.com",
        tier: "official", enabled: true, type: "metafactory",
      })
    ).toThrow("HTTPS");
  });
});

describe("backward compatibility", () => {
  test("legacy sources.yaml without type fields loads correctly", async () => {
    const legacy = `sources:
  - name: my-hub
    url: https://example.com/REGISTRY.yaml
    tier: community
    enabled: true
`;
    await Bun.write(env.paths.sourcesPath, legacy);

    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0].type).toBeUndefined();
    expect(getSourceType(config.sources[0])).toBe("registry");
  });
});

describe("forward compatibility", () => {
  test("unknown fields are silently ignored", async () => {
    const futureConfig = `sources:
  - name: future-source
    url: https://example.com/REG.yaml
    tier: community
    enabled: true
    type: registry
    future_field: some_value
    another_unknown: 123
`;
    await Bun.write(env.paths.sourcesPath, futureConfig);

    const config = await loadSources(env.paths.sourcesPath);
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0].name).toBe("future-source");
  });
});

describe("token handling", () => {
  test("token field is parsed from YAML", async () => {
    const config: SourcesConfig = {
      sources: [{
        name: "auth-source", url: "https://meta-factory.ai",
        tier: "official", enabled: true, type: "metafactory",
        token: "secret-token-123",
      }],
    };
    await Bun.write(env.paths.sourcesPath, YAML.stringify(config));

    const loaded = await loadSources(env.paths.sourcesPath);
    expect(loaded.sources[0].token).toBe("secret-token-123");
  });

  test("empty token treated as falsy", async () => {
    const config: SourcesConfig = {
      sources: [{
        name: "auth-source", url: "https://meta-factory.ai",
        tier: "official", enabled: true, type: "metafactory",
        token: "",
      }],
    };
    await Bun.write(env.paths.sourcesPath, YAML.stringify(config));

    const loaded = await loadSources(env.paths.sourcesPath);
    expect(loaded.sources[0].token || undefined).toBeUndefined();
  });
});
