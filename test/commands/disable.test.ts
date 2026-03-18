import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { disable } from "../../src/commands/disable.js";
import { enable } from "../../src/commands/enable.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("disable command", () => {
  test("removes skill symlink", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const skillLink = join(env.paths.skillsDir, "TestSkill");
    expect(existsSync(skillLink)).toBe(true);

    await disable(env.db, env.paths, "TestSkill");
    expect(existsSync(skillLink)).toBe(false);
  });

  test("updates packages.db status to disabled", async () => {
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

    const skill = getSkill(env.db, "TestSkill");
    expect(skill!.status).toBe("disabled");
  });

  test("preserves repo in repos directory", async () => {
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

    const repoDir = join(env.paths.reposDir, "mock-TestSkill");
    expect(existsSync(repoDir)).toBe(true);
  });

  test("rejects non-installed skill", async () => {
    const result = await disable(env.db, env.paths, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });
});

describe("enable command", () => {
  test("re-creates skill symlink", async () => {
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
    await enable(env.db, env.paths, "TestSkill");

    const skillLink = join(env.paths.skillsDir, "TestSkill");
    expect(existsSync(skillLink)).toBe(true);
  });

  test("updates packages.db status to active", async () => {
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
    await enable(env.db, env.paths, "TestSkill");

    const skill = getSkill(env.db, "TestSkill");
    expect(skill!.status).toBe("active");
  });

  test("rejects enabling non-disabled skill", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = await enable(env.db, env.paths, "TestSkill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already active");
  });
});
