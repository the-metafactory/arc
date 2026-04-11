import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  searchAcrossSources,
  formatSearch,
  formatSearchJson,
  formatWarnings,
  parseArtifactType,
  parsePackageTier,
} from "../../src/commands/search.js";
import { saveSources } from "../../src/lib/sources.js";
import type { SourcesConfig, SearchResult } from "../../src/types.js";
import { writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// Helper: create a REGISTRY.yaml file and return file:// URL
async function createLocalRegistry(content: object): Promise<string> {
  const path = join(env.paths.reposDir, `reg-${Math.random()}.yaml`);
  await writeFile(path, YAML.stringify(content));
  return `file://${path}`;
}

// ---------------------------------------------------------------------------
// parseArtifactType / parsePackageTier
// ---------------------------------------------------------------------------

describe("parseArtifactType", () => {
  test("accepts valid types", () => {
    expect(parseArtifactType("skill")).toBe("skill");
    expect(parseArtifactType("tool")).toBe("tool");
    expect(parseArtifactType("agent")).toBe("agent");
    expect(parseArtifactType("prompt")).toBe("prompt");
    expect(parseArtifactType("component")).toBe("component");
    expect(parseArtifactType("pipeline")).toBe("pipeline");
    expect(parseArtifactType("action")).toBe("action");
  });

  test("rejects invalid types", () => {
    expect(parseArtifactType("invalid")).toBeNull();
    expect(parseArtifactType("")).toBeNull();
    expect(parseArtifactType("SKILL")).toBeNull();
  });
});

describe("parsePackageTier", () => {
  test("accepts valid tiers", () => {
    expect(parsePackageTier("official")).toBe("official");
    expect(parsePackageTier("community")).toBe("community");
    expect(parsePackageTier("custom")).toBe("custom");
  });

  test("rejects invalid tiers", () => {
    expect(parsePackageTier("invalid")).toBeNull();
    expect(parsePackageTier("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchAcrossSources
// ---------------------------------------------------------------------------

describe("searchAcrossSources", () => {
  test("returns empty result with zero sources when none configured", async () => {
    const config: SourcesConfig = { sources: [] };
    const result = await searchAcrossSources(config, env.paths.cachePath);
    expect(result.results).toEqual([]);
    expect(result.totalSources).toBe(0);
    expect(result.successfulSources).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test("returns results from local file registry", async () => {
    const url = await createLocalRegistry({
      registry: {
        skills: [
          { name: "research", description: "Multi-agent research", author: "alice", version: "1.0.0", source: "", type: "community", status: "shipped" },
          { name: "writer", description: "Content writer", author: "bob", version: "1.0.0", source: "", type: "community", status: "shipped" },
        ],
        tools: [],
        agents: [],
        prompts: [],
      },
    });

    const config: SourcesConfig = {
      sources: [{ name: "local", url, tier: "community", enabled: true }],
    };
    await saveSources(env.paths.sourcesPath, config);

    const result = await searchAcrossSources(config, env.paths.cachePath);
    expect(result.results.length).toBe(2);
    expect(result.successfulSources).toBe(1);
    expect(result.totalSources).toBe(1);
  });

  test("filters by keyword", async () => {
    const url = await createLocalRegistry({
      registry: {
        skills: [
          { name: "research", description: "Multi-agent research", author: "alice", version: "1.0.0", source: "", type: "community", status: "shipped" },
          { name: "writer", description: "Content writer", author: "bob", version: "1.0.0", source: "", type: "community", status: "shipped" },
        ],
        tools: [], agents: [], prompts: [],
      },
    });

    const config: SourcesConfig = {
      sources: [{ name: "local", url, tier: "community", enabled: true }],
    };

    const result = await searchAcrossSources(config, env.paths.cachePath, { keyword: "research" });
    expect(result.results.length).toBe(1);
    expect(result.results[0].entry.name).toBe("research");
  });

  test("filters by type", async () => {
    const url = await createLocalRegistry({
      registry: {
        skills: [{ name: "s1", description: "Skill 1", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        tools: [{ name: "t1", description: "Tool 1", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        agents: [], prompts: [],
      },
    });

    const config: SourcesConfig = {
      sources: [{ name: "local", url, tier: "community", enabled: true }],
    };

    const skillsOnly = await searchAcrossSources(config, env.paths.cachePath, { type: "skill" });
    expect(skillsOnly.results.length).toBe(1);
    expect(skillsOnly.results[0].artifactType).toBe("skill");

    const toolsOnly = await searchAcrossSources(config, env.paths.cachePath, { type: "tool" });
    expect(toolsOnly.results.length).toBe(1);
    expect(toolsOnly.results[0].artifactType).toBe("tool");
  });

  test("filters by tier", async () => {
    const officialUrl = await createLocalRegistry({
      registry: {
        skills: [{ name: "s1", description: "Skill", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        tools: [], agents: [], prompts: [],
      },
    });
    const communityUrl = await createLocalRegistry({
      registry: {
        skills: [{ name: "s2", description: "Skill", author: "b", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        tools: [], agents: [], prompts: [],
      },
    });

    const config: SourcesConfig = {
      sources: [
        { name: "off", url: officialUrl, tier: "official", enabled: true },
        { name: "com", url: communityUrl, tier: "community", enabled: true },
      ],
    };

    const officialOnly = await searchAcrossSources(config, env.paths.cachePath, { tier: "official" });
    expect(officialOnly.results.length).toBe(1);
    expect(officialOnly.results[0].sourceTier).toBe("official");
  });

  test("combines type and tier filters", async () => {
    const url = await createLocalRegistry({
      registry: {
        skills: [{ name: "s1", description: "Skill", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        tools: [{ name: "t1", description: "Tool", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        agents: [], prompts: [],
      },
    });
    const config: SourcesConfig = {
      sources: [{ name: "local", url, tier: "official", enabled: true }],
    };

    const result = await searchAcrossSources(config, env.paths.cachePath, { type: "skill", tier: "official" });
    expect(result.results.length).toBe(1);
    expect(result.results[0].artifactType).toBe("skill");
    expect(result.results[0].sourceTier).toBe("official");

    const emptyResult = await searchAcrossSources(config, env.paths.cachePath, { type: "skill", tier: "community" });
    expect(emptyResult.results.length).toBe(0);
  });

  test("captures warnings for unreachable sources", async () => {
    const config: SourcesConfig = {
      sources: [
        { name: "missing", url: "file:///nonexistent/path.yaml", tier: "community", enabled: true },
      ],
    };
    const result = await searchAcrossSources(config, env.paths.cachePath);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].sourceName).toBe("missing");
    expect(result.warnings[0].reason).toBe("unreachable");
    expect(result.successfulSources).toBe(0);
  });

  test("healthy sources work when another fails", async () => {
    const workingUrl = await createLocalRegistry({
      registry: {
        skills: [{ name: "s1", description: "Works", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        tools: [], agents: [], prompts: [],
      },
    });
    const config: SourcesConfig = {
      sources: [
        { name: "broken", url: "file:///nonexistent/path.yaml", tier: "community", enabled: true },
        { name: "working", url: workingUrl, tier: "official", enabled: true },
      ],
    };

    const result = await searchAcrossSources(config, env.paths.cachePath);
    expect(result.results.length).toBe(1);
    expect(result.successfulSources).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  test("disabled sources are ignored", async () => {
    const url = await createLocalRegistry({
      registry: {
        skills: [{ name: "s1", description: "Skill", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" }],
        tools: [], agents: [], prompts: [],
      },
    });
    const config: SourcesConfig = {
      sources: [{ name: "local", url, tier: "community", enabled: false }],
    };

    const result = await searchAcrossSources(config, env.paths.cachePath);
    expect(result.totalSources).toBe(0);
    expect(result.results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatSearch
// ---------------------------------------------------------------------------

describe("formatSearch", () => {
  test("shows no-sources message when zero sources", () => {
    const result: SearchResult = { results: [], warnings: [], totalSources: 0, successfulSources: 0 };
    const output = formatSearch(result);
    expect(output).toContain("No sources configured");
    expect(output).toContain("arc source add");
  });

  test("shows no-matches message when sources exist but no results", () => {
    const result: SearchResult = { results: [], warnings: [], totalSources: 2, successfulSources: 2 };
    const output = formatSearch(result);
    expect(output).toContain("No matches found");
  });

  test("shows results with tier badge", () => {
    const result: SearchResult = {
      results: [{
        entry: { name: "research", description: "Multi-agent", author: "alice", version: "1.0.0", source: "", type: "community", status: "shipped" },
        artifactType: "skill",
        sourceName: "metafactory",
        sourceTier: "official",
      }],
      warnings: [],
      totalSources: 1,
      successfulSources: 1,
    };
    const output = formatSearch(result);
    expect(output).toContain("research");
    expect(output).toContain("[skill]");
    expect(output).toContain("[official]");
    expect(output).toContain("Multi-agent");
    expect(output).toContain("by alice");
    expect(output).toContain("source: metafactory");
  });

  test("shows beta and deprecated badges", () => {
    const result: SearchResult = {
      results: [
        { entry: { name: "b", description: "Beta", author: "a", version: "1.0.0", source: "", type: "community", status: "beta" }, artifactType: "skill", sourceName: "s", sourceTier: "community" },
        { entry: { name: "d", description: "Old", author: "a", version: "1.0.0", source: "", type: "community", status: "deprecated" }, artifactType: "skill", sourceName: "s", sourceTier: "community" },
      ],
      warnings: [],
      totalSources: 1,
      successfulSources: 1,
    };
    const output = formatSearch(result);
    expect(output).toContain("(beta)");
    expect(output).toContain("(deprecated)");
  });

  test("shows source ratio in header", () => {
    const result: SearchResult = {
      results: [{
        entry: { name: "x", description: "Test", author: "a", version: "1.0.0", source: "", type: "community", status: "shipped" },
        artifactType: "skill", sourceName: "s", sourceTier: "community",
      }],
      warnings: [],
      totalSources: 3,
      successfulSources: 2,
    };
    const output = formatSearch(result);
    expect(output).toContain("2/3 sources");
  });
});

// ---------------------------------------------------------------------------
// formatWarnings
// ---------------------------------------------------------------------------

describe("formatWarnings", () => {
  test("returns empty string when no warnings", () => {
    const result: SearchResult = { results: [], warnings: [], totalSources: 1, successfulSources: 1 };
    expect(formatWarnings(result)).toBe("");
  });

  test("formats single warning", () => {
    const result: SearchResult = {
      results: [],
      warnings: [{
        sourceName: "broken",
        reason: "unreachable",
        message: 'Source "broken" unreachable',
        usedStaleCache: false,
      }],
      totalSources: 1,
      successfulSources: 0,
    };
    const output = formatWarnings(result);
    expect(output).toContain("Warning:");
    expect(output).toContain("broken");
    expect(output).toContain("unreachable");
  });

  test("shows stale cache suffix", () => {
    const result: SearchResult = {
      results: [],
      warnings: [{
        sourceName: "flaky",
        reason: "unreachable",
        message: 'Source "flaky" unreachable',
        usedStaleCache: true,
      }],
      totalSources: 1,
      successfulSources: 0,
    };
    const output = formatWarnings(result);
    expect(output).toContain("using stale cache");
  });

  test("formats multiple warnings on separate lines", () => {
    const result: SearchResult = {
      results: [],
      warnings: [
        { sourceName: "a", reason: "unreachable", message: 'Source "a" unreachable', usedStaleCache: false },
        { sourceName: "b", reason: "malformed", message: 'Source "b" returned malformed data', usedStaleCache: false },
      ],
      totalSources: 2,
      successfulSources: 0,
    };
    const output = formatWarnings(result);
    expect(output.split("\n").length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatSearchJson
// ---------------------------------------------------------------------------

describe("formatSearchJson", () => {
  test("returns valid JSON with results and meta", () => {
    const result: SearchResult = {
      results: [{
        entry: { name: "research", description: "Multi-agent", author: "alice", version: "1.0.0", source: "https://example.com/r", type: "community", status: "shipped" },
        artifactType: "skill",
        sourceName: "metafactory",
        sourceTier: "official",
      }],
      warnings: [],
      totalSources: 1,
      successfulSources: 1,
    };

    const json = formatSearchJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].name).toBe("research");
    expect(parsed.results[0].type).toBe("skill");
    expect(parsed.results[0].source.name).toBe("metafactory");
    expect(parsed.results[0].source.tier).toBe("official");
    expect(parsed.meta.total).toBe(1);
    expect(parsed.meta.sources.total).toBe(1);
    expect(parsed.meta.sources.successful).toBe(1);
    expect(parsed.meta.sources.failed).toBe(0);
    expect(parsed.meta.warnings).toEqual([]);
  });

  test("includes warnings in meta", () => {
    const result: SearchResult = {
      results: [],
      warnings: [{
        sourceName: "broken",
        reason: "unreachable",
        message: 'Source "broken" unreachable',
        usedStaleCache: false,
      }],
      totalSources: 1,
      successfulSources: 0,
    };

    const json = formatSearchJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.meta.warnings.length).toBe(1);
    expect(parsed.meta.warnings[0].sourceName).toBe("broken");
    expect(parsed.meta.sources.failed).toBe(1);
  });

  test("output is pretty-printed", () => {
    const result: SearchResult = { results: [], warnings: [], totalSources: 0, successfulSources: 0 };
    const json = formatSearchJson(result);
    // Pretty JSON has newlines
    expect(json).toContain("\n");
  });
});
