import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { verify } from "../../src/commands/verify.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("verify command", () => {
  test("checks symlink validity", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = await verify(env.db, env.paths, "TestSkill");
    expect(result.allPassed).toBe(true);

    const symlinkCheck = result.checks.find((c) =>
      c.check.includes("symlink")
    );
    expect(symlinkCheck?.passed).toBe(true);
  });

  test("checks arc-manifest.yaml exists", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = await verify(env.db, env.paths, "TestSkill");
    const manifestCheck = result.checks.find((c) =>
      c.check.includes("manifest")
    );
    expect(manifestCheck?.passed).toBe(true);
  });

  test("returns error for non-installed skill", async () => {
    const result = await verify(env.db, env.paths, "NonExistent");
    expect(result.allPassed).toBe(false);
    expect(result.error).toContain("not installed");
  });
});
