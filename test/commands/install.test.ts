import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, readlinkSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install, parseNameVersion } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
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

  test("reads arc-manifest.yaml from cloned repo", async () => {
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

  test("rejects repo without arc-manifest.yaml", async () => {
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
    expect(result.error).toContain("No arc-manifest.yaml");
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

  test("installs pipeline to pipelines directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "P_RSS_DIGEST",
      type: "pipeline",
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("P_RSS_DIGEST");

    const pipelineLink = join(env.paths.pipelinesDir, "P_RSS_DIGEST");
    expect(existsSync(pipelineLink)).toBe(true);
    expect(lstatSync(pipelineLink).isSymbolicLink()).toBe(true);

    const skill = getSkill(env.db, "P_RSS_DIGEST");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("pipeline");
  });

  test("removes pipeline and cleans up CLI shims", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "P_CLI_PIPE",
      type: "pipeline",
      withCli: true,
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Verify installed
    const pipelineLink = join(env.paths.pipelinesDir, "P_CLI_PIPE");
    expect(existsSync(pipelineLink)).toBe(true);
    const binLink = join(env.paths.binDir, "p_cli_pipe");
    expect(existsSync(binLink)).toBe(true);

    // Remove
    const result = await remove(env.db, env.paths, "P_CLI_PIPE");
    expect(result.success).toBe(true);

    // Verify cleaned up
    expect(existsSync(pipelineLink)).toBe(false);
    expect(existsSync(binLink)).toBe(false);
    expect(getSkill(env.db, "P_CLI_PIPE")).toBeNull();
  });

  test("installs action to actions directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "A_DISCOVER_REPOS",
      type: "action",
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("A_DISCOVER_REPOS");

    const actionLink = join(env.paths.actionsDir, "A_DISCOVER_REPOS");
    expect(existsSync(actionLink)).toBe(true);
    expect(lstatSync(actionLink).isSymbolicLink()).toBe(true);

    const skill = getSkill(env.db, "A_DISCOVER_REPOS");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("action");

    // Remove
    const removeResult = await remove(env.db, env.paths, "A_DISCOVER_REPOS");
    expect(removeResult.success).toBe(true);
    expect(existsSync(actionLink)).toBe(false);
    expect(getSkill(env.db, "A_DISCOVER_REPOS")).toBeNull();
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

  test("installs pinned version by checking out git tag", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "VersionedSkill",
      version: "1.0.0",
    });

    // Create v1.0.0 tag on the initial commit
    Bun.spawnSync(
      ["git", "tag", "v1.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    // Make a new commit with v2.0.0
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await Bun.write(manifestPath, content.replace("1.0.0", "2.0.0"));
    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump to 2.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    Bun.spawnSync(
      ["git", "tag", "v2.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    // Install pinned to v1.0.0
    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedVersion: "1.0.0",
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("1.0.0");
  });

  test("fails when pinned version tag does not exist", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "NoTagSkill",
      version: "1.0.0",
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedVersion: "9.9.9",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Version 9.9.9 not found");
  });

  test("accepts version tag without v prefix", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "PlainTagSkill",
      version: "1.0.0",
    });

    // Create tag without v prefix
    Bun.spawnSync(
      ["git", "tag", "1.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedVersion: "1.0.0",
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("1.0.0");
  });
});

describe("parseNameVersion", () => {
  test("parses name@version", () => {
    expect(parseNameVersion("MySkill@1.2.0")).toEqual({ name: "MySkill", version: "1.2.0" });
  });

  test("parses name@version with v prefix", () => {
    expect(parseNameVersion("MySkill@v2.0.0")).toEqual({ name: "MySkill", version: "2.0.0" });
  });

  test("returns null for bare name", () => {
    expect(parseNameVersion("MySkill")).toBeNull();
  });

  test("returns null for URLs", () => {
    expect(parseNameVersion("https://github.com/foo/bar")).toBeNull();
    expect(parseNameVersion("git@github.com:foo/bar.git")).toBeNull();
  });

  test("returns null for scoped refs", () => {
    expect(parseNameVersion("@scope/name@1.0.0")).toBeNull();
  });

  test("returns null for non-semver suffix", () => {
    expect(parseNameVersion("Skill@latest")).toBeNull();
    expect(parseNameVersion("Skill@main")).toBeNull();
  });

  test("handles minor-only semver", () => {
    expect(parseNameVersion("Skill@1.0")).toEqual({ name: "Skill", version: "1.0" });
  });
});
