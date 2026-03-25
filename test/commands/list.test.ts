import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { list, formatList } from "../../src/commands/list.js";
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

  test("shows empty message when no skills installed", () => {
    const result = list(env.db);
    expect(result.skills.length).toBe(0);

    const output = formatList(result);
    expect(output).toContain("No packages installed");
  });
});
