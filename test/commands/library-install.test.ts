import { describe, test, expect, afterEach } from "bun:test";
import { install } from "../../src/commands/install.js";
import { list } from "../../src/commands/list.js";
import { remove } from "../../src/commands/remove.js";
import { createTestEnv, createMockLibraryRepo, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";
import { existsSync } from "fs";
import { join } from "path";

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

describe("library install", () => {
  test("installs a single artifact from a library via artifactName", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
      artifactName: "alpha",
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("test-lib");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts![0].name).toBe("alpha");

    // Verify DB record
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(1);
    expect(installed.skills[0].name).toBe("alpha");
    expect(installed.skills[0].library_name).toBe("test-lib");

    // Verify symlink exists
    expect(existsSync(join(env.paths.skillsDir, "alpha"))).toBe(true);
  });

  test("installs all artifacts from a library", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts![0].name).toBe("alpha");
    expect(result.artifacts![1].name).toBe("beta");

    const installed = list(env.db);
    expect(installed.skills).toHaveLength(2);
    expect(installed.skills.every((s) => s.library_name === "test-lib")).toBe(true);
  });

  test("errors when artifact not found in library", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
      artifactName: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in library");
  });

  test("library_name is null for standalone installs", async () => {
    env = await createTestEnv();
    const skill = await createMockSkillRepo(env.root, { name: "standalone" });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: skill.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(1);
    expect(installed.skills[0].library_name).toBeNull();
  });

  test("list --library filters by library name", async () => {
    env = await createTestEnv();

    // Install a library
    const lib = await createMockLibraryRepo(env.root, {
      name: "my-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });
    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Install a standalone
    const standalone = await createMockSkillRepo(env.root, { name: "standalone" });
    await install({ paths: env.paths, db: env.db, repoUrl: standalone.url, yes: true });

    // List all
    const allResult = list(env.db);
    expect(allResult.skills).toHaveLength(3);

    // List by library
    const libResult = list(env.db, { library: "my-lib" });
    expect(libResult.skills).toHaveLength(2);
    expect(libResult.skills.every((s) => s.library_name === "my-lib")).toBe(true);
  });

  test("remove single artifact leaves other library artifacts intact", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Remove just alpha
    const removeResult = await remove(env.db, env.paths, "alpha");
    expect(removeResult.success).toBe(true);

    // Beta should still be installed
    const remaining = list(env.db);
    expect(remaining.skills).toHaveLength(1);
    expect(remaining.skills[0].name).toBe("beta");
  });

  test("installs mixed artifact types from library", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "mixed-lib",
      artifacts: [
        { path: "skills/review", name: "review", type: "skill" },
        { path: "agents/helper", name: "helper", type: "agent" },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.artifacts).toHaveLength(2);

    const installed = list(env.db);
    expect(installed.skills).toHaveLength(2);
    const types = installed.skills.map((s) => s.artifact_type).sort();
    expect(types).toEqual(["agent", "skill"]);
  });

  test("skips already-installed artifacts", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    // First install — all
    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Second install — should skip already-installed
    const result2 = await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });
    expect(result2.success).toBe(true);
    // Both artifacts should be "success" (skipped counts as success)
    expect(result2.artifacts!.every((a) => a.success)).toBe(true);

    // Still only 2 in DB (not duplicated)
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(2);
  });
});
