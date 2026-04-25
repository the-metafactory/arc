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

describe("install provides.files (issue #84)", () => {
  /**
   * Build a skill repo whose arc-manifest.yaml declares provides.files and/or
   * provides.hooks. Used to exercise the type-agnostic provides.files pass and
   * the hook-target validation gate.
   */
  async function buildRepoWithProvides(opts: {
    name: string;
    extraFiles?: Record<string, string>;
    providesFiles?: Array<{ source: string; target: string }>;
    providesHooks?: Array<{ event: string; command: string }>;
  }): Promise<string> {
    const repoDir = join(env.root, `mock-${opts.name}`);
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(repoDir, "skill"), { recursive: true });
    await writeFile(
      join(repoDir, "skill", "SKILL.md"),
      `---\nname: ${opts.name}\ndescription: Test\n---\n# ${opts.name}\n`,
    );
    for (const [path, content] of Object.entries(opts.extraFiles ?? {})) {
      const abs = join(repoDir, path);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    const lines: string[] = [
      `name: ${opts.name}`,
      `version: 1.0.0`,
      `type: skill`,
      `tier: custom`,
      `author:`,
      `  name: testuser`,
      `  github: testuser`,
      `provides:`,
      `  skill:`,
      `    - trigger: ${opts.name.toLowerCase()}`,
    ];
    if (opts.providesFiles?.length) {
      lines.push(`  files:`);
      for (const f of opts.providesFiles) {
        lines.push(`    - source: ${JSON.stringify(f.source)}`);
        lines.push(`      target: ${JSON.stringify(f.target)}`);
      }
    }
    if (opts.providesHooks?.length) {
      lines.push(`  hooks:`);
      for (const h of opts.providesHooks) {
        lines.push(`    - event: ${h.event}`);
        lines.push(`      command: ${JSON.stringify(h.command)}`);
      }
    }
    lines.push(`capabilities:`);
    lines.push(`  filesystem: { read: [], write: [] }`);
    lines.push(`  network: []`);
    lines.push(`  bash: { allowed: false }`);
    lines.push(`  secrets: []`);
    await writeFile(join(repoDir, "arc-manifest.yaml"), lines.join("\n") + "\n");
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    return repoDir;
  }

  test("honors provides.files entries on a skill-type package", async () => {
    const targetPath = join(env.root, "out", "handler.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "FileSkill",
      extraFiles: { "src/handler.ts": "// handler\n" },
      providesFiles: [{ source: "src/handler.ts", target: targetPath }],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetPath)).toContain("src/handler.ts");
  });

  test("fails install when provides.files source is missing from package", async () => {
    const targetPath = join(env.root, "out", "missing.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "MissingSourceSkill",
      providesFiles: [{ source: "src/missing.ts", target: targetPath }],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("provides.files");
    expect(result.error).toContain("src/missing.ts");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("fails install when provides.hooks command points at non-existent file", async () => {
    const missingHandler = join(env.root, "ghost", "handler.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "GhostHookSkill",
      providesHooks: [
        { event: "Stop", command: missingHandler },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("hooks");
    expect(result.error).toContain(missingHandler);
    // settings.json must not have been written with the broken hook
    if (existsSync(env.paths.settingsPath)) {
      const settings = JSON.parse(await Bun.file(env.paths.settingsPath).text());
      const stopHooks = settings.hooks?.Stop ?? [];
      const ghostFound = stopHooks.some((g: { _pai_pkg?: string }) => g._pai_pkg === "GhostHookSkill");
      expect(ghostFound).toBe(false);
    }
  });

  test("provides.hooks with $PKG_DIR resolves to installed file and registers", async () => {
    const repoUrl = await buildRepoWithProvides({
      name: "GoodHookSkill",
      extraFiles: { "hooks/Stop.ts": "// stop\n" },
      providesHooks: [
        { event: "Stop", command: "${PKG_DIR}/hooks/Stop.ts" },
      ],
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(true);
    const settings = JSON.parse(await Bun.file(env.paths.settingsPath).text());
    const stopHooks = settings.hooks?.Stop ?? [];
    const ours = stopHooks.find((g: { _pai_pkg?: string }) => g._pai_pkg === "GoodHookSkill");
    expect(ours).toBeDefined();
    expect(ours.hooks[0].command).toContain("hooks/Stop.ts");
    expect(ours.hooks[0].command).not.toContain("${PKG_DIR}");
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
