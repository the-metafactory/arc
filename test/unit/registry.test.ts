import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  loadRegistry,
  searchRegistry,
  findRegistryEntry,
  addFromRegistry,
  formatRegistrySearch,
} from "../../src/lib/registry.js";
import type { RegistryConfig, CatalogConfig } from "../../src/types.js";
import YAML from "yaml";

let env: TestEnv;

function sampleRegistry(): RegistryConfig {
  return {
    registry: {
      skills: [
        {
          name: "Research",
          description: "Multi-agent research with parallel researchers",
          author: "danielmiessler",
          source: "https://github.com/danielmiessler/pai/blob/main/skills/Research/SKILL.md",
          type: "builtin",
          status: "shipped",
        },
        {
          name: "SpecFlow",
          description: "Spec-driven development workflow",
          author: "jcfischer",
          source: "https://github.com/jcfischer/specflow-bundle/blob/main/skill/SKILL.md",
          type: "community",
          status: "shipped",
          has_cli: true,
          bundle: true,
          reviewed_by: ["mellanon"],
        },
        {
          name: "OldTool",
          description: "A deprecated tool",
          author: "someone",
          source: "https://github.com/someone/old-tool/blob/main/SKILL.md",
          type: "community",
          status: "deprecated",
        },
      ],
      agents: [
        {
          name: "Architect",
          description: "Elite system design specialist",
          author: "danielmiessler",
          source: "https://github.com/danielmiessler/pai/blob/main/agents/Architect.md",
          type: "builtin",
          status: "shipped",
        },
      ],
      prompts: [],
      tools: [],
    },
  };
}

function emptyCatalog(): CatalogConfig {
  return {
    defaults: {
      skills_dir: "~/.claude/skills/",
      agents_dir: "~/.claude/agents/",
      prompts_dir: "~/.claude/commands/",
      tools_dir: "~/.claude/bin/",
    },
    catalog: {
      skills: [],
      agents: [],
      prompts: [],
      tools: [],
    },
  };
}

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("loadRegistry", () => {
  test("loads valid registry.yaml", async () => {
    await Bun.write(
      env.paths.registryPath,
      YAML.stringify(sampleRegistry())
    );

    const config = await loadRegistry(env.paths.registryPath);
    expect(config).not.toBeNull();
    expect(config!.registry.skills).toHaveLength(3);
    expect(config!.registry.agents).toHaveLength(1);
    expect(config!.registry.prompts).toHaveLength(0);
  });

  test("returns null for missing file", async () => {
    const config = await loadRegistry(env.paths.registryPath);
    expect(config).toBeNull();
  });

  test("throws for invalid registry (missing section)", async () => {
    await Bun.write(env.paths.registryPath, "foo: bar\n");
    await expect(loadRegistry(env.paths.registryPath)).rejects.toThrow(
      "missing 'registry' section"
    );
  });
});

describe("searchRegistry", () => {
  test("finds by name (case-insensitive)", () => {
    const results = searchRegistry(sampleRegistry(), "specflow");
    expect(results).toHaveLength(1);
    expect(results[0].entry.name).toBe("SpecFlow");
    expect(results[0].entry.author).toBe("jcfischer");
  });

  test("finds by description", () => {
    const results = searchRegistry(sampleRegistry(), "parallel");
    expect(results).toHaveLength(1);
    expect(results[0].entry.name).toBe("Research");
  });

  test("returns multiple matches", () => {
    const results = searchRegistry(sampleRegistry(), "spec");
    // "SpecFlow" name match + "Elite system design specialist" description
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("searches across types", () => {
    const results = searchRegistry(sampleRegistry(), "design");
    expect(results).toHaveLength(1);
    expect(results[0].artifactType).toBe("agent");
  });

  test("returns empty for no match", () => {
    const results = searchRegistry(sampleRegistry(), "zzzznotfound");
    expect(results).toHaveLength(0);
  });
});

describe("findRegistryEntry", () => {
  test("finds skill by exact name", () => {
    const result = findRegistryEntry(sampleRegistry(), "SpecFlow");
    expect(result).not.toBeNull();
    expect(result!.entry.author).toBe("jcfischer");
    expect(result!.artifactType).toBe("skill");
  });

  test("finds agent by exact name", () => {
    const result = findRegistryEntry(sampleRegistry(), "Architect");
    expect(result).not.toBeNull();
    expect(result!.artifactType).toBe("agent");
  });

  test("returns null for unknown", () => {
    expect(findRegistryEntry(sampleRegistry(), "Nope")).toBeNull();
  });
});

describe("addFromRegistry", () => {
  test("copies entry from registry to catalog", () => {
    const registry = sampleRegistry();
    const catalog = emptyCatalog();

    const { entry, artifactType } = addFromRegistry(registry, catalog, "SpecFlow");
    expect(artifactType).toBe("skill");
    expect(entry.name).toBe("SpecFlow");
    expect(entry.has_cli).toBe(true);
    expect(entry.bundle).toBe(true);

    // Verify added to catalog
    expect(catalog.catalog.skills).toHaveLength(1);
    expect(catalog.catalog.skills[0].name).toBe("SpecFlow");
  });

  test("copies agent entry", () => {
    const registry = sampleRegistry();
    const catalog = emptyCatalog();

    const { entry, artifactType } = addFromRegistry(registry, catalog, "Architect");
    expect(artifactType).toBe("agent");
    expect(catalog.catalog.agents).toHaveLength(1);
  });

  test("strips registry-specific fields", () => {
    const registry = sampleRegistry();
    const catalog = emptyCatalog();

    addFromRegistry(registry, catalog, "SpecFlow");
    const added = catalog.catalog.skills[0] as any;
    // These should NOT be on the catalog entry
    expect(added.author).toBeUndefined();
    expect(added.status).toBeUndefined();
    expect(added.reviewed_by).toBeUndefined();
  });

  test("preserves requires field", () => {
    const registry = sampleRegistry();
    // Add a skill with requires
    registry.registry.skills.push({
      name: "Council",
      description: "Multi-agent debate",
      author: "danielmiessler",
      source: "https://github.com/danielmiessler/pai/blob/main/skills/Thinking/Council/SKILL.md",
      type: "builtin",
      status: "shipped",
      requires: ["skill:Thinking"],
    });
    const catalog = emptyCatalog();

    addFromRegistry(registry, catalog, "Council");
    expect(catalog.catalog.skills[0].requires).toEqual(["skill:Thinking"]);
  });

  test("throws if not found in registry", () => {
    const registry = sampleRegistry();
    const catalog = emptyCatalog();

    expect(() => addFromRegistry(registry, catalog, "NonExistent")).toThrow(
      "not found in registry"
    );
  });

  test("throws if already in catalog", () => {
    const registry = sampleRegistry();
    const catalog = emptyCatalog();
    catalog.catalog.skills.push({
      name: "SpecFlow",
      description: "Already here",
      source: "https://example.com",
      type: "custom",
    });

    expect(() => addFromRegistry(registry, catalog, "SpecFlow")).toThrow(
      "already exists in your catalog"
    );
  });
});

describe("formatRegistrySearch", () => {
  test("formats results with author and source", () => {
    const results = searchRegistry(sampleRegistry(), "specflow");
    const output = formatRegistrySearch(results);
    expect(output).toContain("SpecFlow");
    expect(output).toContain("jcfischer");
    expect(output).toContain("source:");
    expect(output).toContain("reviewed by: mellanon");
  });

  test("shows deprecated badge", () => {
    const results = searchRegistry(sampleRegistry(), "deprecated");
    const output = formatRegistrySearch(results);
    expect(output).toContain("(deprecated)");
  });

  test("returns message for no matches", () => {
    const output = formatRegistrySearch([]);
    expect(output).toContain("No matches found");
  });
});
