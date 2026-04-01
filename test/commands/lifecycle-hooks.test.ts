import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { writeFile } from "fs/promises";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { upgradePackage } from "../../src/commands/upgrade.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("install lifecycle hooks", () => {
  test("runs preinstall script before symlinks", async () => {
    const markerPath = join(env.root, "preinstall-ran");
    const repo = await createMockSkillRepo(env.root, {
      name: "HookedSkill",
      scripts: {
        preinstall: {
          path: "./scripts/preinstall.sh",
          content: `#!/bin/bash\necho "preinstall" > "${markerPath}"\n`,
        },
      },
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    const content = await Bun.file(markerPath).text();
    expect(content.trim()).toBe("preinstall");
  });

  test("runs postinstall script after install", async () => {
    const markerPath = join(env.root, "postinstall-ran");
    const repo = await createMockSkillRepo(env.root, {
      name: "PostHookedSkill",
      scripts: {
        postinstall: {
          path: "./scripts/postinstall.sh",
          content: `#!/bin/bash\necho "postinstall" > "${markerPath}"\n`,
        },
      },
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
  });

  test("runs both preinstall and postinstall in order", async () => {
    const logPath = join(env.root, "hook-order.log");
    const repo = await createMockSkillRepo(env.root, {
      name: "BothHooks",
      scripts: {
        preinstall: {
          path: "./scripts/preinstall.sh",
          content: `#!/bin/bash\necho "pre" >> "${logPath}"\n`,
        },
        postinstall: {
          path: "./scripts/postinstall.sh",
          content: `#!/bin/bash\necho "post" >> "${logPath}"\n`,
        },
      },
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const log = await Bun.file(logPath).text();
    const lines = log.trim().split("\n");
    expect(lines).toEqual(["pre", "post"]);
  });

  test("fails install if preinstall script fails", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "FailPre",
      scripts: {
        preinstall: {
          path: "./scripts/preinstall.sh",
          content: `#!/bin/bash\nexit 1\n`,
        },
      },
    });

    const result = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Preinstall script failed");
  });

  test("receives PAI_INSTALL_PATH env var", async () => {
    const markerPath = join(env.root, "env-check");
    const repo = await createMockSkillRepo(env.root, {
      name: "EnvCheck",
      scripts: {
        postinstall: {
          path: "./scripts/postinstall.sh",
          content: `#!/bin/bash\necho "$PAI_INSTALL_PATH" > "${markerPath}"\n`,
        },
      },
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const content = await Bun.file(markerPath).text();
    expect(content.trim()).toContain("repos/mock-EnvCheck");
  });
});

describe("upgrade lifecycle hooks", () => {
  test("runs preupgrade and postupgrade during upgrade", async () => {
    const logPath = join(env.root, "upgrade-hooks.log");

    // First install at v1.0.0 — no upgrade hooks yet
    const repo = await createMockSkillRepo(env.root, {
      name: "UpgradeHooked",
      version: "1.0.0",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Now simulate v1.1.0 with upgrade hooks: update manifest + add scripts + commit
    const scriptsDir = join(repo.path, "scripts");
    await Bun.write(
      join(scriptsDir, "preupgrade.sh"),
      `#!/bin/bash\necho "preupgrade" >> "${logPath}"\n`
    );
    await Bun.write(
      join(scriptsDir, "postupgrade.sh"),
      `#!/bin/bash\necho "postupgrade" >> "${logPath}"\n`
    );
    Bun.spawnSync(["chmod", "+x", join(scriptsDir, "preupgrade.sh")], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["chmod", "+x", join(scriptsDir, "postupgrade.sh")], { stdout: "pipe", stderr: "pipe" });

    // Update manifest with version bump and scripts
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    let manifestContent = await Bun.file(manifestPath).text();
    manifestContent = manifestContent.replace("version: 1.0.0", "version: 1.1.0");
    manifestContent += "\nscripts:\n  preupgrade: ./scripts/preupgrade.sh\n  postupgrade: ./scripts/postupgrade.sh\n";
    await writeFile(manifestPath, manifestContent);

    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "v1.1.0 with hooks"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" }
    );

    const result = await upgradePackage(env.db, env.paths, "UpgradeHooked");
    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("1.1.0");

    const log = await Bun.file(logPath).text();
    const lines = log.trim().split("\n");
    expect(lines).toEqual(["preupgrade", "postupgrade"]);
  });

  test("postupgrade falls back to postinstall", async () => {
    const logPath = join(env.root, "fallback-hook.log");

    const repo = await createMockSkillRepo(env.root, {
      name: "FallbackHook",
      version: "1.0.0",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // v1.1.0 with only postinstall (no postupgrade) — should be called during upgrade
    const scriptsDir = join(repo.path, "scripts");
    await Bun.write(
      join(scriptsDir, "postinstall.sh"),
      `#!/bin/bash\necho "postinstall-fallback" >> "${logPath}"\n`
    );
    Bun.spawnSync(["chmod", "+x", join(scriptsDir, "postinstall.sh")], { stdout: "pipe", stderr: "pipe" });

    const manifestPath = join(repo.path, "arc-manifest.yaml");
    let manifestContent = await Bun.file(manifestPath).text();
    manifestContent = manifestContent.replace("version: 1.0.0", "version: 1.1.0");
    manifestContent += "\nscripts:\n  postinstall: ./scripts/postinstall.sh\n";
    await writeFile(manifestPath, manifestContent);

    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "v1.1.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" }
    );

    const result = await upgradePackage(env.db, env.paths, "FallbackHook");
    expect(result.success).toBe(true);

    const log = await Bun.file(logPath).text();
    expect(log.trim()).toBe("postinstall-fallback");
  });

  test("receives version env vars during upgrade", async () => {
    const markerPath = join(env.root, "version-env");

    const repo = await createMockSkillRepo(env.root, {
      name: "VersionEnv",
      version: "1.0.0",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // v1.1.0 with postupgrade that captures version env vars
    const scriptsDir = join(repo.path, "scripts");
    await Bun.write(
      join(scriptsDir, "postupgrade.sh"),
      `#!/bin/bash\necho "$PAI_OLD_VERSION -> $PAI_NEW_VERSION" > "${markerPath}"\n`
    );
    Bun.spawnSync(["chmod", "+x", join(scriptsDir, "postupgrade.sh")], { stdout: "pipe", stderr: "pipe" });

    const manifestPath = join(repo.path, "arc-manifest.yaml");
    let manifestContent = await Bun.file(manifestPath).text();
    manifestContent = manifestContent.replace("version: 1.0.0", "version: 1.1.0");
    manifestContent += "\nscripts:\n  postupgrade: ./scripts/postupgrade.sh\n";
    await writeFile(manifestPath, manifestContent);

    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "v1.1.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" }
    );

    const result = await upgradePackage(env.db, env.paths, "VersionEnv");
    expect(result.success).toBe(true);

    const content = await Bun.file(markerPath).text();
    expect(content.trim()).toBe("1.0.0 -> 1.1.0");
  });

  test("fails upgrade if preupgrade script fails", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "FailUpgrade",
      version: "1.0.0",
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // v1.1.0 with failing preupgrade
    const scriptsDir = join(repo.path, "scripts");
    await Bun.write(join(scriptsDir, "preupgrade.sh"), `#!/bin/bash\nexit 1\n`);
    Bun.spawnSync(["chmod", "+x", join(scriptsDir, "preupgrade.sh")], { stdout: "pipe", stderr: "pipe" });

    const manifestPath = join(repo.path, "arc-manifest.yaml");
    let manifestContent = await Bun.file(manifestPath).text();
    manifestContent = manifestContent.replace("version: 1.0.0", "version: 1.1.0");
    manifestContent += "\nscripts:\n  preupgrade: ./scripts/preupgrade.sh\n";
    await writeFile(manifestPath, manifestContent);

    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "v1.1.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" }
    );

    const result = await upgradePackage(env.db, env.paths, "FailUpgrade");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Preupgrade script failed");
  });
});

describe("runScript unit", () => {
  test("skips gracefully when script file does not exist", async () => {
    const { runScript } = await import("../../src/lib/scripts.js");
    const result = runScript({
      installPath: env.root,
      scriptPath: "./nonexistent.sh",
      hookName: "test",
      quiet: true,
    });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });
});
