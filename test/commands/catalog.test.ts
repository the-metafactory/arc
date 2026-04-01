import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import YAML from "yaml";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { saveCatalog } from "../../src/lib/catalog.js";
import { getSkill } from "../../src/lib/db.js";
import type { CatalogConfig, CatalogEntry } from "../../src/types.js";
import {
  catalogList,
  catalogSearch,
  catalogAdd,
  catalogRemove,
  catalogUse,
  catalogSync,
  formatCatalogList,
  formatCatalogSearch,
} from "../../src/commands/catalog.js";

let env: TestEnv;

function sampleCatalog(root: string): CatalogConfig {
  return {
    defaults: {
      skills_dir: join(root, ".claude", "skills") + "/",
      agents_dir: join(root, ".claude", "agents") + "/",
      prompts_dir: join(root, ".claude", "commands") + "/",
      tools_dir: join(root, ".claude", "bin") + "/",
    },
    catalog: {
      skills: [
        {
          name: "Research",
          description: "Multi-agent research with parallel researchers",
          source: join(root, "mock-skills", "Research", "SKILL.md"),
          type: "builtin",
        },
        {
          name: "Thinking",
          description: "Unified analytical thinking modes",
          source: join(root, "mock-skills", "Thinking", "SKILL.md"),
          type: "builtin",
        },
        {
          name: "Council",
          description: "Multi-agent debate with visible transcripts",
          source: join(root, "mock-skills", "Thinking", "Council", "SKILL.md"),
          type: "builtin",
          requires: ["skill:Thinking"],
        },
      ],
      agents: [
        {
          name: "Architect",
          description: "Elite system design specialist",
          source: join(root, "mock-agents", "Architect.md"),
          type: "builtin",
        },
      ],
      prompts: [],
      tools: [],
    },
  };
}

async function createMockSkillDir(
  root: string,
  path: string,
  opts?: { name?: string; withManifest?: boolean }
): Promise<void> {
  const dir = join(root, path);
  const name = opts?.name ?? "MockSkill";
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\n---\n\n# ${name}\n`
  );

  if (opts?.withManifest !== false) {
    const manifest = {
      name,
      version: "1.0.0",
      type: "skill",
      author: { name: "testuser", github: "testuser" },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    };
    await writeFile(
      join(dir, "arc-manifest.yaml"),
      YAML.stringify(manifest)
    );
  }
}

async function createMockAgentFile(
  root: string,
  path: string,
  name: string
): Promise<void> {
  const dir = join(root, path);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.md`),
    `# ${name}\n\nElite specialist.\n`
  );
}

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("catalogList", () => {
  test("returns error when no catalog exists", async () => {
    const result = await catalogList(env.paths, env.db);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No catalog.yaml");
  });

  test("lists all entries with install status", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogList(env.paths, env.db);
    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(4); // 3 skills + 1 agent
    expect(result.items!.every((i) => !i.installed)).toBe(true);
  });

  test("formatCatalogList shows entries", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogList(env.paths, env.db);
    const output = formatCatalogList(result);
    expect(output).toContain("Research");
    expect(output).toContain("Architect");
    expect(output).toContain("[skill]");
    expect(output).toContain("[agent]");
  });
});

describe("catalogSearch", () => {
  test("finds entries by name", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.paths, "research");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].entry.name).toBe("Research");
  });

  test("finds entries by description", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.paths, "debate");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].entry.name).toBe("Council");
  });

  test("returns empty for no match", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.paths, "zzzznotfound");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  test("formatCatalogSearch shows results", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.paths, "design");
    const output = formatCatalogSearch(result);
    expect(output).toContain("Architect");
    expect(output).toContain("source:");
  });
});

describe("catalogAdd", () => {
  test("adds entry to catalog", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const entry: CatalogEntry = {
      name: "SpecFlow",
      description: "Spec-driven development",
      source: "https://github.com/jcfischer/specflow-bundle/blob/main/skill/SKILL.md",
      type: "community",
      has_cli: true,
    };

    const result = await catalogAdd(env.paths, entry, "skill");
    expect(result.success).toBe(true);
    expect(result.name).toBe("SpecFlow");

    // Verify persisted
    const listResult = await catalogList(env.paths, env.db);
    expect(listResult.items!.some((i) => i.entry.name === "SpecFlow")).toBe(true);
  });

  test("rejects duplicate name", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const entry: CatalogEntry = {
      name: "Research",
      description: "Duplicate",
      source: "https://example.com",
      type: "custom",
    };

    const result = await catalogAdd(env.paths, entry, "skill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });
});

describe("catalogRemove", () => {
  test("removes entry from catalog", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogRemove(env.paths, "Research");
    expect(result.success).toBe(true);

    const listResult = await catalogList(env.paths, env.db);
    expect(listResult.items!.some((i) => i.entry.name === "Research")).toBe(
      false
    );
  });

  test("returns error for non-existent entry", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogRemove(env.paths, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("catalogUse", () => {
  test("installs local skill entry and records in DB", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.paths, env.db, "Research");
    expect(result.success).toBe(true);
    expect(result.installed).toHaveLength(1);
    expect(result.installed![0].name).toBe("Research");

    // Verify the skill dir was created
    const skillDir = join(env.paths.skillsDir, "Research");
    expect(existsSync(skillDir)).toBe(true);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

    // Verify DB record
    const dbRecord = getSkill(env.db, "Research");
    expect(dbRecord).not.toBeNull();
    expect(dbRecord!.name).toBe("Research");
    expect(dbRecord!.status).toBe("active");
    expect(dbRecord!.repo_url).toContain("mock-skills/Research/SKILL.md");
  });

  test("installs local agent entry", async () => {
    await createMockAgentFile(env.root, "mock-agents", "Architect");
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.paths, env.db, "Architect");
    expect(result.success).toBe(true);
    expect(result.installed).toHaveLength(1);
    expect(result.installed![0].artifactType).toBe("agent");

    // Verify agent file was copied
    const agentFile = join(env.root, ".claude", "agents", "Architect.md");
    expect(existsSync(agentFile)).toBe(true);
  });

  test("resolves dependencies before installing", async () => {
    await createMockSkillDir(env.root, "mock-skills/Thinking", { name: "Thinking" });
    await createMockSkillDir(env.root, "mock-skills/Thinking/Council", { name: "Council" });
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.paths, env.db, "Council");
    expect(result.success).toBe(true);
    expect(result.installed).toHaveLength(2);
    // Thinking (dep) installed first, then Council
    expect(result.installed![0].name).toBe("Thinking");
    expect(result.installed![1].name).toBe("Council");

    expect(existsSync(join(env.paths.skillsDir, "Thinking"))).toBe(true);
    expect(existsSync(join(env.paths.skillsDir, "Council"))).toBe(true);
  });

  test("catalog list shows installed status after use", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    await catalogUse(env.paths, env.db, "Research");

    const listResult = await catalogList(env.paths, env.db);
    const researchItem = listResult.items!.find(
      (i) => i.entry.name === "Research"
    );
    expect(researchItem!.installed).toBe(true);
    expect(researchItem!.status).toBe("active");
  });

  test("refreshes already-installed skill (overwrites)", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    // Install first time
    await catalogUse(env.paths, env.db, "Research");
    expect(existsSync(join(env.paths.skillsDir, "Research", "SKILL.md"))).toBe(
      true
    );

    // Install again (refresh)
    const result = await catalogUse(env.paths, env.db, "Research");
    expect(result.success).toBe(true);
    expect(existsSync(join(env.paths.skillsDir, "Research", "SKILL.md"))).toBe(
      true
    );
  });

  test("returns error for unknown entry", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.paths, env.db, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("catalogSync", () => {
  test("returns empty when nothing installed", async () => {
    await saveCatalog(env.paths.catalogPath, sampleCatalog(env.root));

    const result = await catalogSync(env.paths, env.db);
    expect(result.success).toBe(true);
    expect(result.synced).toHaveLength(0);
  });
});
