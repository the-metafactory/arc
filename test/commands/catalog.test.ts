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
  normalizeCatalogSource,
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
    const result = await catalogList(env.arc, env.host, env.db);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No catalog.yaml");
  });

  test("lists all entries with install status", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogList(env.arc, env.host, env.db);
    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(4); // 3 skills + 1 agent
    expect(result.items!.every((i) => !i.installed)).toBe(true);
  });

  test("formatCatalogList shows entries", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogList(env.arc, env.host, env.db);
    const output = formatCatalogList(result);
    expect(output).toContain("Research");
    expect(output).toContain("Architect");
    expect(output).toContain("[skill]");
    expect(output).toContain("[agent]");
  });
});

describe("catalogSearch", () => {
  test("finds entries by name", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.arc, env.host, "research");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].entry.name).toBe("Research");
  });

  test("finds entries by description", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.arc, env.host, "debate");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results![0].entry.name).toBe("Council");
  });

  test("returns empty for no match", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.arc, env.host, "zzzznotfound");
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  test("formatCatalogSearch shows results", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogSearch(env.arc, env.host, "design");
    const output = formatCatalogSearch(result);
    expect(output).toContain("Architect");
    expect(output).toContain("source:");
  });
});

describe("catalogAdd", () => {
  test("adds entry to catalog", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const entry: CatalogEntry = {
      name: "SpecFlow",
      description: "Spec-driven development",
      source: "https://github.com/jcfischer/specflow-bundle/blob/main/skill/SKILL.md",
      type: "community",
      has_cli: true,
    };

    const result = await catalogAdd(env.arc, env.host, entry, "skill");
    expect(result.success).toBe(true);
    expect(result.name).toBe("SpecFlow");

    // Verify persisted
    const listResult = await catalogList(env.arc, env.host, env.db);
    expect(listResult.items!.some((i) => i.entry.name === "SpecFlow")).toBe(true);
  });

  test("rejects duplicate name", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const entry: CatalogEntry = {
      name: "Research",
      description: "Duplicate",
      source: "https://example.com",
      type: "custom",
    };

    const result = await catalogAdd(env.arc, env.host, entry, "skill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });
});

describe("catalogRemove", () => {
  test("removes entry from catalog", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogRemove(env.arc, env.host, "Research");
    expect(result.success).toBe(true);

    const listResult = await catalogList(env.arc, env.host, env.db);
    expect(listResult.items!.some((i) => i.entry.name === "Research")).toBe(
      false
    );
  });

  test("returns error for non-existent entry", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogRemove(env.arc, env.host, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("catalogUse", () => {
  test("installs local skill entry and records in DB", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(true);
    expect(result.installed).toHaveLength(1);
    expect(result.installed![0].name).toBe("Research");

    // Verify the skill dir was created
    const skillDir = join(env.host.paths.skillsDir, "Research");
    expect(existsSync(skillDir)).toBe(true);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

    // Verify DB record
    const dbRecord = getSkill(env.db, "Research");
    expect(dbRecord).not.toBeNull();
    expect(dbRecord!.name).toBe("Research");
    expect(dbRecord!.status).toBe("active");
    expect(dbRecord!.repo_url).toContain("mock-skills/Research/SKILL.md");
  });

  test(
    "surfaces a genuine bun install failure for a CLI/bundle entry instead of silently succeeding (arc#289)",
    async () => {
      // A "CLI tooling" catalog entry (has_cli: true) takes the isCli branch
      // of installSkillEntry, which used to shell out to `bun install`
      // directly with the exit code discarded (arc#289 review finding).
      // Consolidated onto installNodeDependencies/reportNodeDependencyResult
      // — this pins that a genuine dependency failure is now surfaced as a
      // failed catalogUse, not recorded as a successful install.
      const repoDir = join(env.root, "mock-skills", "CliTool");
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, "SKILL.md"), "---\nname: CliTool\n---\n\n# CliTool\n");
      await writeFile(
        join(repoDir, "arc-manifest.yaml"),
        YAML.stringify({
          name: "CliTool",
          version: "1.0.0",
          type: "skill",
          author: { name: "testuser", github: "testuser" },
          capabilities: {
            filesystem: { read: [], write: [] },
            network: [],
            bash: { allowed: false },
            secrets: [],
          },
        }),
      );
      await writeFile(
        join(repoDir, "package.json"),
        JSON.stringify({
          name: "cli-tool",
          version: "1.0.0",
          dependencies: { "arc-284-fixture-does-not-exist-xyz": "^1.0.0" },
        }),
      );

      const catalog = sampleCatalog(env.root);
      catalog.catalog.skills.push({
        name: "CliTool",
        description: "A CLI tool with an unresolvable dependency",
        source: join(repoDir, "SKILL.md"),
        type: "community",
        has_cli: true,
      });
      await saveCatalog(env.arc.catalogPath, catalog);

      const result = await catalogUse(env.arc, env.host, env.db, "CliTool");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to install CliTool");
      expect(result.error).toContain("bun install failed for CliTool");

      // Must NOT be recorded as installed.
      expect(getSkill(env.db, "CliTool")).toBeNull();
    },
    30_000,
  );

  test("installs local agent entry", async () => {
    await createMockAgentFile(env.root, "mock-agents", "Architect");
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.arc, env.host, env.db, "Architect");
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
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.arc, env.host, env.db, "Council");
    expect(result.success).toBe(true);
    expect(result.installed).toHaveLength(2);
    // Thinking (dep) installed first, then Council
    expect(result.installed![0].name).toBe("Thinking");
    expect(result.installed![1].name).toBe("Council");

    expect(existsSync(join(env.host.paths.skillsDir, "Thinking"))).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "Council"))).toBe(true);
  });

  test("catalog list shows installed status after use", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    await catalogUse(env.arc, env.host, env.db, "Research");

    const listResult = await catalogList(env.arc, env.host, env.db);
    const researchItem = listResult.items!.find(
      (i) => i.entry.name === "Research"
    );
    expect(researchItem!.installed).toBe(true);
    expect(researchItem!.status).toBe("active");
  });

  test("refreshes already-installed skill (overwrites)", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    // Install first time
    await catalogUse(env.arc, env.host, env.db, "Research");
    expect(existsSync(join(env.host.paths.skillsDir, "Research", "SKILL.md"))).toBe(
      true
    );

    // Install again (refresh)
    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "Research", "SKILL.md"))).toBe(
      true
    );
  });

  test("returns error for unknown entry", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogUse(env.arc, env.host, env.db, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // arc#170: refuse rather than silently overwrite when a row for the same
  // name already exists from a different source (e.g. a prior `arc install`
  // from a direct URL, or another catalog entry).
  test("arc#170: refuses to overwrite a foreign install of the same name", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    // Pre-existing row with a *different* install_source — simulates
    // `arc install` from a direct URL (or a different catalog source).
    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, install_source, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "Research",
        "1.0.0",
        "git@github.com:other/research.git",
        "/legacy/path",
        "/legacy/path",
        "active",
        "skill",
        "custom",
        "git@github.com:other/research.git",
        now,
        now,
      );

    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already installed from a different source");
    expect(result.error).toContain("arc remove");

    // Critical: the foreign DB row must not have been overwritten.
    const row = getSkill(env.db, "Research");
    expect(row).not.toBeNull();
    expect(row!.install_source).toBe("git@github.com:other/research.git");
    expect(row!.version).toBe("1.0.0");
  });

  test("arc#170: same-name disabled foreign install hints at `arc enable`", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, install_source, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "Research",
        "1.0.0",
        "git@github.com:other/research.git",
        "/legacy/path",
        "/legacy/path",
        "disabled",
        "skill",
        "custom",
        "git@github.com:other/research.git",
        now,
        now,
      );

    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(false);
    expect(result.error).toContain("arc enable");
    expect(result.error).toContain("disabled");
  });

  test("arc#170: refuses foreign library install of the same name", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    // Prior row from a library install (install_source: "library:foo",
    // library_name: "foo"). The error message should surface the library
    // name rather than the raw "library:foo" string.
    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, install_source, library_name, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "Research",
        "0.3.0",
        "git@github.com:foo/foo-library.git",
        "/legacy/path",
        "/legacy/path",
        "active",
        "skill",
        "custom",
        "library:foo",
        "foo",
        now,
        now,
      );

    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(false);
    expect(result.error).toContain("library:foo");
    expect(result.error).toContain("arc remove");
  });

  test("arc#170: refuses foreign install when the conflicting row is from a different catalog source", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    // Foreign install was registered by a different catalog entry whose
    // `source:` points at a different repo. install_source format is exactly
    // what catalog.ts records (the raw catalog `source` string).
    const now = new Date().toISOString();
    const foreignSource = "https://github.com/other-org/other-research/blob/main/SKILL.md";
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, install_source, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "Research",
        "1.0.0",
        foreignSource,
        "/legacy/path",
        "/legacy/path",
        "active",
        "skill",
        "custom",
        foreignSource,
        now,
        now,
      );

    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(false);
    expect(result.error).toContain(foreignSource);
    expect(result.error).toContain("different source");
  });

  test("arc#170: format drift (trailing .git / slash / case) still counts as a refresh of the same source", async () => {
    await createMockSkillDir(env.root, "mock-skills/Research", { name: "Research" });
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    // The catalog entry's source (set in sampleCatalog) for `Research` is a
    // *local* path — those normalise to themselves. Verify the equality
    // discriminator survives a trailing-slash drift.
    const cat = sampleCatalog(env.root);
    const original = cat.catalog.skills.find((s) => s.name === "Research")!.source;

    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, install_source, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "Research",
        "1.0.0",
        original,
        "/legacy/path",
        "/legacy/path",
        "active",
        "skill",
        "custom",
        // Drift: trailing slash + uppercase scheme variant simulating yaml edit
        original + "/",
        now,
        now,
      );

    // Refresh should succeed — same logical source despite the trailing /.
    const result = await catalogUse(env.arc, env.host, env.db, "Research");
    expect(result.success).toBe(true);
  });
});

describe("normalizeCatalogSource", () => {
  test("strips trailing .git", () => {
    expect(normalizeCatalogSource("https://github.com/o/r.git")).toBe(
      "https://github.com/o/r",
    );
    expect(normalizeCatalogSource("https://github.com/o/r.git/")).toBe(
      "https://github.com/o/r",
    );
  });

  test("strips trailing slashes", () => {
    expect(normalizeCatalogSource("https://example.com/path///")).toBe(
      "https://example.com/path",
    );
  });

  test("lowercases protocol + host on http(s) URLs only", () => {
    expect(normalizeCatalogSource("HTTPS://GitHub.com/Org/Repo")).toBe(
      "https://github.com/Org/Repo",
    );
    // Local paths are unchanged
    expect(normalizeCatalogSource("/Users/Foo/Bar.md")).toBe("/Users/Foo/Bar.md");
    // SSH-style URLs: leave case intact (host part is technical, drift unlikely)
    expect(normalizeCatalogSource("git@github.com:Org/Repo.git")).toBe(
      "git@github.com:Org/Repo",
    );
  });

  test("idempotent", () => {
    const s = "https://github.com/o/r/blob/main/skill.md";
    expect(normalizeCatalogSource(normalizeCatalogSource(s))).toBe(
      normalizeCatalogSource(s),
    );
  });

  test("trims whitespace", () => {
    expect(normalizeCatalogSource("  https://example.com/x.git  ")).toBe(
      "https://example.com/x",
    );
  });
});

describe("catalogSync", () => {
  test("returns empty when nothing installed", async () => {
    await saveCatalog(env.arc.catalogPath, sampleCatalog(env.root));

    const result = await catalogSync(env.arc, env.host, env.db);
    expect(result.success).toBe(true);
    expect(result.synced).toHaveLength(0);
  });
});
