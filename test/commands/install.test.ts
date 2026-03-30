import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, readlinkSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("install command", () => {
  test("clones repo to repos directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);

    const repoDir = join(env.paths.reposDir, `mock-TestSkill`);
    expect(existsSync(repoDir)).toBe(true);
  });

  test("reads pai-manifest.yaml from cloned repo", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "2.5.0",
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("TestSkill");
    expect(result.version).toBe("2.5.0");
  });

  test("creates skill symlink in skills directory", async () => {
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
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
  });

  test("creates bin symlink if CLI declared", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "_JIRA",
      withCli: true,
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const binLink = join(env.paths.binDir, "jira");
    expect(existsSync(binLink)).toBe(true);
    expect(lstatSync(binLink).isSymbolicLink()).toBe(true);
  });

  test("records entry in packages.db", async () => {
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

    const skill = getSkill(env.db, "TestSkill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("TestSkill");
    expect(skill!.status).toBe("active");
  });

  test("rejects repo without pai-manifest.yaml", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "BadSkill",
      withoutManifest: true,
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No pai-manifest.yaml");
  });

  test("installs manifest with authors array format", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "MultiAuthor",
      authors: [
        { name: "Jens-Christian Fischer", github: "jcfischer" },
        { name: "Andreas Aastroem", github: "mellanon" },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.manifest!.authors).toHaveLength(2);
    expect(result.manifest!.authors![0].name).toBe("Jens-Christian Fischer");
    expect(result.manifest!.author).toBeUndefined();
  });

  test("rejects already-installed skill", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    // First install
    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Second install should fail
    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already installed");
  });
});
