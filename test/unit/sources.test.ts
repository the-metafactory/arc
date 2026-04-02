import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  createDefaultSources,
  formatSourceList,
} from "../../src/lib/sources.js";
import type { SourcesConfig } from "../../src/types.js";
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
    expect(config.sources[0].tier).toBe("community");
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
  test("formats source list", () => {
    const config = createDefaultSources();
    const output = formatSourceList(config);
    expect(output).toContain("metafactory");
    expect(output).toContain("[community]");
    expect(output).toContain("(enabled)");
  });

  test("handles empty sources", () => {
    const output = formatSourceList({ sources: [] });
    expect(output).toContain("No sources configured");
  });
});
