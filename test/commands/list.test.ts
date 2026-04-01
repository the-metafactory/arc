import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { list, formatList, formatListJson } from "../../src/commands/list.js";
import { disable } from "../../src/commands/disable.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("list command", () => {
  test("shows installed skills with version and status", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "1.2.3",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = list(env.db);
    expect(result.skills.length).toBe(1);
    expect(result.skills[0].name).toBe("TestSkill");
    expect(result.skills[0].version).toBe("1.2.3");
    expect(result.skills[0].status).toBe("active");
  });

  test("shows disabled skills marked as disabled", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    await disable(env.db, env.paths, "TestSkill");

    const result = list(env.db);
    expect(result.skills[0].status).toBe("disabled");

    const output = formatList(result);
    expect(output).toContain("disabled");
  });

  test("outputs valid JSON with --json format", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "1.0.0",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = list(env.db);
    const json = formatListJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0].name).toBe("TestSkill");
    expect(parsed.packages[0].type).toBe("skill");
    expect(parsed.packages[0].status).toBe("active");
    expect(parsed.packages[0].installPath).toBeDefined();
    expect(parsed.packages[0].repoUrl).toBeDefined();
  });

  test("filters by artifact type", async () => {
    const skillRepo = await createMockSkillRepo(env.root, {
      name: "MySkill",
      type: "skill",
    });
    const pipelineRepo = await createMockSkillRepo(env.root, {
      name: "P_DIGEST",
      type: "pipeline",
    });

    await install({ paths: env.paths, db: env.db, repoUrl: skillRepo.url, yes: true });
    await install({ paths: env.paths, db: env.db, repoUrl: pipelineRepo.url, yes: true });

    const all = list(env.db);
    expect(all.skills).toHaveLength(2);

    const pipelines = list(env.db, { type: "pipeline" });
    expect(pipelines.skills).toHaveLength(1);
    expect(pipelines.skills[0].name).toBe("P_DIGEST");

    const skills = list(env.db, { type: "skill" });
    expect(skills.skills).toHaveLength(1);
    expect(skills.skills[0].name).toBe("MySkill");
  });

  test("shows empty message when no skills installed", () => {
    const result = list(env.db);
    expect(result.skills.length).toBe(0);

    const output = formatList(result);
    expect(output).toContain("No packages installed");
  });
});
