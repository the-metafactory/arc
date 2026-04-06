import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  createMockLibraryRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove, removeLibrary } from "../../src/commands/remove.js";
import { getSkill, listByLibrary } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("remove command", () => {
  test("deletes repo directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const repoDir = join(env.paths.reposDir, "mock-TestSkill");
    expect(existsSync(repoDir)).toBe(true);

    await remove(env.db, env.paths, "TestSkill");
    expect(existsSync(repoDir)).toBe(false);
  });

  test("deletes packages.db entry", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    await remove(env.db, env.paths, "TestSkill");
    expect(getSkill(env.db, "TestSkill")).toBeNull();
  });

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

    await remove(env.db, env.paths, "TestSkill");

    const skillLink = join(env.paths.skillsDir, "TestSkill");
    expect(existsSync(skillLink)).toBe(false);
  });

  test("rejects removing non-installed skill", async () => {
    const result = await remove(env.db, env.paths, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });
});

describe("removeLibrary", () => {
  test("removes all artifacts when given library name", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    // Both artifacts should be installed
    expect(getSkill(env.db, "alpha")).not.toBeNull();
    expect(getSkill(env.db, "beta")).not.toBeNull();

    const result = await removeLibrary(env.db, env.paths, "test-lib");
    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(2);
    expect(getSkill(env.db, "alpha")).toBeNull();
    expect(getSkill(env.db, "beta")).toBeNull();
  });

  test("cleans up repo directory after removing all library artifacts", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    // Find the repo directory from the first artifact's install_path
    const alphaSkill = getSkill(env.db, "alpha")!;
    const repoDir = join(alphaSkill.install_path, "..", "..");

    expect(existsSync(repoDir)).toBe(true);

    await removeLibrary(env.db, env.paths, "test-lib");
    expect(existsSync(repoDir)).toBe(false);
  });

  test("individual artifact removal preserves other library artifacts", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    // Remove only alpha
    const result = await remove(env.db, env.paths, "alpha");
    expect(result.success).toBe(true);

    // Beta should still exist
    expect(getSkill(env.db, "beta")).not.toBeNull();
    // Library still has one artifact
    expect(listByLibrary(env.db, "test-lib")).toHaveLength(1);
  });

  test("returns error for unknown name (not artifact, not library)", async () => {
    const result = await removeLibrary(env.db, env.paths, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });
});
