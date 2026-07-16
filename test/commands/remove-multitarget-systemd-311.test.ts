/**
 * Integration tests for arc#311 (L2): multi-target remove dispatch for
 * linux-systemd. Sister to remove-multitarget-i140.test.ts (darwin-launchd).
 *
 * NEVER spawns a real `systemctl` — `remove()`'s injectable `systemctlRunner`
 * is threaded through `removePerTarget` -> `removeSystemdArtifacts` for
 * every test here.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
import { getSkill } from "../../src/lib/db.js";
import type {
  SystemctlRunner,
  SystemctlResult,
  LingerChecker,
} from "../../src/lib/hosts/systemd-install.js";

let env: TestEnv;
let unitDir: string;
let systemdBinDir: string;

beforeEach(async () => {
  env = await createTestEnv();
  unitDir = join(env.root, ".config", "systemd", "user");
  systemdBinDir = join(env.root, "systemd-bin");
  await mkdir(unitDir, { recursive: true });
  await mkdir(systemdBinDir, { recursive: true });
});

afterEach(async () => {
  await env.cleanup();
});

function makeRecorder(responses: Record<string, SystemctlResult> = {}) {
  const calls: string[][] = [];
  const runner: SystemctlRunner = async (args) => {
    calls.push(args);
    return responses[args.join(" ")] ?? { code: 0, stderr: "" };
  };
  return { runner, calls };
}

function makeLingerChecker(enabled: boolean): LingerChecker {
  return async () => ({ enabled, username: "testuser" });
}

const hostOverrides = () => ({
  "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" as const },
});

async function makeStandaloneBotRepo(name: string): Promise<{ url: string }> {
  const repoDir = join(env.root, `mock-${name}`);
  await mkdir(join(repoDir, "bin"), { recursive: true });
  await writeFile(join(repoDir, "bin", name), `#!/bin/bash\n`);
  await chmod(join(repoDir, "bin", name), 0o755);
  await mkdir(join(repoDir, "services"), { recursive: true });
  await writeFile(join(repoDir, "services", `${name}.service`), `[Service]\nExecStart={{BIN}}\n`);
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `name: ${name}
version: 0.1.0
type: agent
tier: custom
targets: [linux-systemd]
identity:
  id: ${name}
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
provides:
  binary: bin/${name}
  systemdUnit: services/${name}.service
`,
  );
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  return { url: repoDir };
}

async function installBot(name: string) {
  const repo = await makeStandaloneBotRepo(name);
  const { runner } = makeRecorder();
  return install({
    arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
    hostOverrides: hostOverrides(),
    systemctlRunner: runner,
    lingerChecker: makeLingerChecker(true),
  });
}

describe("remove: linux-systemd multi-target uninstall", () => {
  test("remove disables + deletes the unit, reloads, and removes the binary symlink — nothing left behind", async () => {
    await installBot("alpha-bot");
    const unitPath = join(unitDir, "alpha-bot.service");
    const binLink = join(systemdBinDir, "alpha-bot");
    expect(existsSync(unitPath)).toBe(true);
    expect(existsSync(binLink)).toBe(true);

    const { runner, calls } = makeRecorder();
    const result = await remove(env.db, env.arc, env.host, "alpha-bot", {
      quiet: true,
      hostOverrides: hostOverrides(),
      systemctlRunner: runner,
    });

    expect(result.success).toBe(true);
    expect(existsSync(unitPath)).toBe(false);
    expect(existsSync(binLink)).toBe(false);
    expect(getSkill(env.db, "alpha-bot")).toBeNull();
    expect(calls).toEqual([
      ["--user", "disable", "--now", "alpha-bot.service"],
      ["--user", "daemon-reload"],
    ]);
  });

  test("remove is best-effort on a systemctl warning — a not-loaded disable does not abort the remove", async () => {
    await installBot("beta-bot");
    const unitPath = join(unitDir, "beta-bot.service");

    const { runner } = makeRecorder({
      "--user disable --now beta-bot.service": {
        code: 1,
        stderr: "Failed to disable unit: Unit file beta-bot.service does not exist.",
      },
    });
    const result = await remove(env.db, env.arc, env.host, "beta-bot", {
      quiet: true,
      hostOverrides: hostOverrides(),
      systemctlRunner: runner,
    });

    expect(result.success).toBe(true);
    // Unit file + symlink still get removed even though `disable` reported non-zero.
    expect(existsSync(unitPath)).toBe(false);
    expect(existsSync(join(systemdBinDir, "beta-bot"))).toBe(false);
  });

  test("legacy single-target remove path is unaffected (regression check)", async () => {
    const repoDir = join(env.root, "mock-legacy");
    await mkdir(join(repoDir, "skill"), { recursive: true });
    await writeFile(join(repoDir, "skill", "SKILL.md"), `---\nname: LegacySkill\n---\n`);
    await writeFile(
      join(repoDir, "arc-manifest.yaml"),
      `name: LegacySkill
version: 1.0.0
type: skill
tier: custom
provides:
  skill: [{ trigger: legacyskill }]
capabilities:
  filesystem: { read: [], write: [] }
  network: []
  bash: { allowed: false }
  secrets: []
`,
    );
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repoDir, yes: true });
    const result = await remove(env.db, env.arc, env.host, "LegacySkill", { quiet: true });
    expect(result.success).toBe(true);
    expect(getSkill(env.db, "LegacySkill")).toBeNull();
  });
});
