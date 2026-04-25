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

  // Issue #85: arc verify must validate that hook command paths registered
  // in settings.json actually resolve. A package whose installer wired hooks
  // to files that were never placed should fail verify, not pass it.
  test("passes when no hooks are registered", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "NoHookSkill",
    });
    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = await verify(env.db, env.paths, "NoHookSkill");
    expect(result.allPassed).toBe(true);
    const hookCheck = result.checks.find((c) => c.check.includes("Hook command"));
    expect(hookCheck).toBeUndefined();
  });

  test("passes when registered hook command paths resolve", async () => {
    // Build a manifest with provides.files + provides.hooks pointing at the
    // same file — install.ts gates this end-to-end (issue #84) so a
    // successful install means the hook target exists. Verify should agree.
    const { mkdir, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const repoDir = join(env.root, "mock-LiveHook");
    await mkdir(join(repoDir, "skill"), { recursive: true });
    await writeFile(
      join(repoDir, "skill", "SKILL.md"),
      `---\nname: LiveHook\ndescription: Test\n---\n# LiveHook\n`,
    );
    await mkdir(join(repoDir, "hooks"), { recursive: true });
    await writeFile(join(repoDir, "hooks", "Stop.ts"), `// stop\n`);

    const targetPath = join(env.root, ".claude", "hooks", "Stop.ts");
    const yaml = [
      `name: LiveHook`,
      `version: 1.0.0`,
      `type: skill`,
      `tier: custom`,
      `author: { name: t, github: t }`,
      `provides:`,
      `  skill: [{ trigger: livehook }]`,
      `  files:`,
      `    - source: hooks/Stop.ts`,
      `      target: ${JSON.stringify(targetPath)}`,
      `  hooks:`,
      `    - event: Stop`,
      `      command: ${JSON.stringify(targetPath)}`,
      `capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] }`,
    ].join("\n") + "\n";
    await writeFile(join(repoDir, "arc-manifest.yaml"), yaml);
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const installResult = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repoDir,
      yes: true,
    });
    expect(installResult.success).toBe(true);

    const result = await verify(env.db, env.paths, "LiveHook");
    const hookCheck = result.checks.find((c) => c.check.includes("Hook command"));
    expect(hookCheck).toBeDefined();
    expect(hookCheck!.passed).toBe(true);
  });

  test("fails when registered hook target was deleted post-install", async () => {
    // Simulates the caduceus shape from the issue body: install succeeded at
    // some point, the hook is in settings.json, but the file the hook points
    // at no longer exists on disk. arc verify must surface this loudly.
    const { mkdir, writeFile, rm } = await import("fs/promises");
    const { join } = await import("path");
    const repoDir = join(env.root, "mock-DeletedHook");
    await mkdir(join(repoDir, "skill"), { recursive: true });
    await writeFile(
      join(repoDir, "skill", "SKILL.md"),
      `---\nname: DeletedHook\ndescription: Test\n---\n# DeletedHook\n`,
    );
    await mkdir(join(repoDir, "hooks"), { recursive: true });
    await writeFile(join(repoDir, "hooks", "SkillNudge.ts"), `// nudge\n`);

    const targetPath = join(env.root, ".claude", "hooks", "SkillNudge.ts");
    const yaml = [
      `name: DeletedHook`,
      `version: 1.0.0`,
      `type: skill`,
      `tier: custom`,
      `author: { name: t, github: t }`,
      `provides:`,
      `  skill: [{ trigger: deletedhook }]`,
      `  files:`,
      `    - source: hooks/SkillNudge.ts`,
      `      target: ${JSON.stringify(targetPath)}`,
      `  hooks:`,
      `    - event: Stop`,
      `      command: ${JSON.stringify(targetPath)}`,
      `capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] }`,
    ].join("\n") + "\n";
    await writeFile(join(repoDir, "arc-manifest.yaml"), yaml);
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const installResult = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repoDir,
      yes: true,
    });
    expect(installResult.success).toBe(true);

    // Now break it: delete the target file (and its symlink). Settings.json
    // still points at the path, repo dir still has the source file.
    await rm(targetPath, { force: true });

    const result = await verify(env.db, env.paths, "DeletedHook");
    expect(result.allPassed).toBe(false);
    const hookCheck = result.checks.find((c) => c.check.includes("Hook command"));
    expect(hookCheck).toBeDefined();
    expect(hookCheck!.passed).toBe(false);
    expect(hookCheck!.detail).toContain("missing");
    expect(hookCheck!.detail).toContain(targetPath);
    // Hint: file lives at hooks/SkillNudge.ts in the repo; verify should
    // surface that so the user knows where the gap is.
    expect(hookCheck!.detail).toContain("hooks/SkillNudge.ts");
    expect(hookCheck!.detail).toContain("provides.files");
  });
});
