import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import {
  loadCatalog,
  saveCatalog,
  findEntry,
  searchCatalog,
  listCatalog,
  addEntry,
  removeEntry,
  resolveDependencies,
} from "../../src/lib/catalog.js";
import type { CatalogConfig, CatalogEntry } from "../../src/types.js";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";

let env: TestEnv;

function sampleCatalog(): CatalogConfig {
  return {
    defaults: {
      skills_dir: "~/.claude/skills/",
      agents_dir: "~/.claude/agents/",
      prompts_dir: "~/.claude/commands/",
      tools_dir: "~/.claude/bin/",
    },
    catalog: {
      skills: [
        {
          name: "Research",
          description: "Multi-agent research",
          source: "https://github.com/danielmiessler/pai/blob/main/skills/Research/SKILL.md",
          type: "builtin",
        },
        {
          name: "Thinking",
          description: "Unified analytical thinking",
          source: "https://github.com/danielmiessler/pai/blob/main/skills/Thinking/SKILL.md",
          type: "builtin",
        },
        {
          name: "Council",
          description: "Multi-agent debate",
          source: "https://github.com/danielmiessler/pai/blob/main/skills/Thinking/Council/SKILL.md",
          type: "builtin",
          requires: ["skill:Thinking"],
        },
      ],
      agents: [
        {
          name: "Architect",
          description: "Elite system design specialist",
          source: "https://github.com/danielmiessler/pai/blob/main/agents/Architect.md",
          type: "builtin",
        },
      ],
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

describe("loadCatalog", () => {
  test("loads valid catalog.yaml", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog());

    const config = await loadCatalog(env.paths.catalogPath);
    expect(config).not.toBeNull();
    expect(config!.catalog.skills).toHaveLength(3);
    expect(config!.catalog.agents).toHaveLength(1);
    expect(config!.catalog.prompts).toHaveLength(0);
    expect(config!.defaults.skills_dir).toBe("~/.claude/skills/");
  });

  test("returns null for missing file", async () => {
    const config = await loadCatalog(env.paths.catalogPath);
    expect(config).toBeNull();
  });

  test("throws for invalid catalog (missing sections)", async () => {
    await Bun.write(env.paths.catalogPath, "foo: bar\n");
    await expect(loadCatalog(env.paths.catalogPath)).rejects.toThrow(
      "missing required sections"
    );
  });

  test("handles catalog with null arrays gracefully", async () => {
    await Bun.write(
      env.paths.catalogPath,
      `defaults:
  skills_dir: ~/.claude/skills/
  agents_dir: ~/.claude/agents/
  prompts_dir: ~/.claude/commands/
  tools_dir: ~/.claude/bin/
catalog:
  skills: null
  agents: null
  prompts: null
  tools: null
`
    );
    const config = await loadCatalog(env.paths.catalogPath);
    expect(config).not.toBeNull();
    expect(config!.catalog.skills).toEqual([]);
    expect(config!.catalog.agents).toEqual([]);
    expect(config!.catalog.prompts).toEqual([]);
    expect(config!.catalog.tools).toEqual([]);
  });
});

describe("saveCatalog", () => {
  test("round-trips catalog through YAML", async () => {
    const original = sampleCatalog();
    await saveCatalog(env.paths.catalogPath, original);

    const loaded = await loadCatalog(env.paths.catalogPath);
    expect(loaded!.catalog.skills).toHaveLength(3);
    expect(loaded!.catalog.skills[0].name).toBe("Research");
    expect(loaded!.catalog.skills[2].requires).toEqual(["skill:Thinking"]);
    expect(loaded!.catalog.agents[0].name).toBe("Architect");
  });
});

describe("findEntry", () => {
  test("finds skill by name", () => {
    const config = sampleCatalog();
    const result = findEntry(config, "Research");
    expect(result).not.toBeNull();
    expect(result!.entry.name).toBe("Research");
    expect(result!.artifactType).toBe("skill");
  });

  test("finds agent by name", () => {
    const config = sampleCatalog();
    const result = findEntry(config, "Architect");
    expect(result).not.toBeNull();
    expect(result!.entry.name).toBe("Architect");
    expect(result!.artifactType).toBe("agent");
  });

  test("returns null for unknown name", () => {
    const config = sampleCatalog();
    expect(findEntry(config, "NonExistent")).toBeNull();
  });
});

describe("searchCatalog", () => {
  test("searches by name (case-insensitive)", () => {
    const config = sampleCatalog();
    const results = searchCatalog(config, "research");
    expect(results).toHaveLength(1);
    expect(results[0].entry.name).toBe("Research");
  });

  test("searches by description", () => {
    const config = sampleCatalog();
    const results = searchCatalog(config, "debate");
    expect(results).toHaveLength(1);
    expect(results[0].entry.name).toBe("Council");
  });

  test("returns multiple matches", () => {
    const config = sampleCatalog();
    const results = searchCatalog(config, "agent");
    // "Multi-agent research" + "Multi-agent debate"
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("returns empty for no matches", () => {
    const config = sampleCatalog();
    expect(searchCatalog(config, "zzzznotfound")).toHaveLength(0);
  });

  test("matches across artifact types", () => {
    const config = sampleCatalog();
    const results = searchCatalog(config, "design");
    expect(results).toHaveLength(1);
    expect(results[0].artifactType).toBe("agent");
  });
});

describe("listCatalog", () => {
  test("lists all entries with installed=false when DB is empty", () => {
    const config = sampleCatalog();
    const items = listCatalog(config, env.db);
    expect(items).toHaveLength(4); // 3 skills + 1 agent
    expect(items.every((i) => i.installed === false)).toBe(true);
  });
});

describe("addEntry", () => {
  test("adds skill entry", () => {
    const config = sampleCatalog();
    const newEntry: CatalogEntry = {
      name: "SpecFlow",
      description: "Spec-driven development",
      source: "https://github.com/jcfischer/specflow-bundle/blob/main/skill/SKILL.md",
      type: "community",
      has_cli: true,
      bundle: true,
    };

    addEntry(config, newEntry, "skill");
    expect(config.catalog.skills).toHaveLength(4);
    expect(config.catalog.skills[3].name).toBe("SpecFlow");
  });

  test("adds agent entry", () => {
    const config = sampleCatalog();
    const newAgent: CatalogEntry = {
      name: "Pentester",
      description: "Offensive security specialist",
      source: "https://github.com/danielmiessler/pai/blob/main/agents/Pentester.md",
      type: "builtin",
    };

    addEntry(config, newAgent, "agent");
    expect(config.catalog.agents).toHaveLength(2);
  });

  test("throws on duplicate name", () => {
    const config = sampleCatalog();
    const dup: CatalogEntry = {
      name: "Research",
      description: "Duplicate",
      source: "https://example.com",
      type: "custom",
    };

    expect(() => addEntry(config, dup, "skill")).toThrow("already exists");
  });

  test("throws on duplicate name across types", () => {
    const config = sampleCatalog();
    const dup: CatalogEntry = {
      name: "Architect",
      description: "Duplicate as skill",
      source: "https://example.com",
      type: "custom",
    };

    expect(() => addEntry(config, dup, "skill")).toThrow("already exists");
  });
});

describe("removeEntry", () => {
  test("removes existing skill", () => {
    const config = sampleCatalog();
    const removed = removeEntry(config, "Research");
    expect(removed).toBe(true);
    expect(config.catalog.skills).toHaveLength(2);
    expect(findEntry(config, "Research")).toBeNull();
  });

  test("removes existing agent", () => {
    const config = sampleCatalog();
    const removed = removeEntry(config, "Architect");
    expect(removed).toBe(true);
    expect(config.catalog.agents).toHaveLength(0);
  });

  test("returns false for non-existent entry", () => {
    const config = sampleCatalog();
    expect(removeEntry(config, "NonExistent")).toBe(false);
  });
});

describe("resolveDependencies", () => {
  test("returns entry with no deps", () => {
    const config = sampleCatalog();
    const result = resolveDependencies(config, "Research");
    expect(result).toHaveLength(1);
    expect(result[0].entry.name).toBe("Research");
  });

  test("resolves single dependency (deps first)", () => {
    const config = sampleCatalog();
    const result = resolveDependencies(config, "Council");
    expect(result).toHaveLength(2);
    expect(result[0].entry.name).toBe("Thinking"); // dep first
    expect(result[1].entry.name).toBe("Council");
  });

  test("resolves chained dependencies", () => {
    const config = sampleCatalog();
    // Add a skill that depends on Council (which depends on Thinking)
    addEntry(
      config,
      {
        name: "DeepDebate",
        description: "Extended council",
        source: "https://example.com/SKILL.md",
        type: "community",
        requires: ["skill:Council"],
      },
      "skill"
    );

    const result = resolveDependencies(config, "DeepDebate");
    expect(result).toHaveLength(3);
    expect(result[0].entry.name).toBe("Thinking");
    expect(result[1].entry.name).toBe("Council");
    expect(result[2].entry.name).toBe("DeepDebate");
  });

  test("detects circular dependency", () => {
    const config = sampleCatalog();
    // Make Thinking depend on Council (Council already depends on Thinking)
    const thinking = config.catalog.skills.find((s) => s.name === "Thinking")!;
    thinking.requires = ["skill:Council"];

    expect(() => resolveDependencies(config, "Council")).toThrow(
      "Circular dependency"
    );
  });

  test("throws for unknown entry", () => {
    const config = sampleCatalog();
    expect(() => resolveDependencies(config, "NonExistent")).toThrow(
      "not found in catalog"
    );
  });

  test("deduplicates shared dependencies", () => {
    const config = sampleCatalog();
    // Add RedTeam which also depends on Thinking
    addEntry(
      config,
      {
        name: "RedTeam",
        description: "Adversarial stress testing",
        source: "https://example.com/SKILL.md",
        type: "builtin",
        requires: ["skill:Thinking"],
      },
      "skill"
    );

    // Add a skill depending on both Council and RedTeam
    addEntry(
      config,
      {
        name: "FullAnalysis",
        description: "Council + RedTeam",
        source: "https://example.com/SKILL.md",
        type: "community",
        requires: ["skill:Council", "skill:RedTeam"],
      },
      "skill"
    );

    const result = resolveDependencies(config, "FullAnalysis");
    const names = result.map((r) => r.entry.name);
    // Thinking should appear only once despite being dep of both Council and RedTeam
    expect(names.filter((n) => n === "Thinking")).toHaveLength(1);
    // Thinking must come before both Council and RedTeam
    expect(names.indexOf("Thinking")).toBeLessThan(names.indexOf("Council"));
    expect(names.indexOf("Thinking")).toBeLessThan(names.indexOf("RedTeam"));
  });
});
