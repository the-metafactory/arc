/**
 * Integration tests for arc#311 (L2): multi-target install dispatch for
 * linux-systemd. Sister to install-multitarget-i140.test.ts (darwin-launchd).
 *
 * NEVER spawns a real `systemctl`/`loginctl` — `install()`'s injectable
 * `systemctlRunner`/`lingerChecker` are threaded through `installPerTarget`
 * -> `installSystemdArtifacts` -> `completeInstallTransaction` for every
 * test here, mirroring how `hostOverrides` isolates paths.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod, readFile } from "fs/promises";
import { join } from "path";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
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

/** Records every `systemctl --user <args>` call; args-keyed canned responses. */
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

/** A standalone bot repo targeting linux-systemd only, binary + unit provided. */
async function createStandaloneBotRepo(opts: { parent: string; name: string }): Promise<{ url: string }> {
  const repoDir = join(opts.parent, `mock-${opts.name}`);
  await mkdir(repoDir, { recursive: true });
  await mkdir(join(repoDir, "bin"), { recursive: true });
  await writeFile(join(repoDir, "bin", opts.name), `#!/bin/bash\necho "${opts.name} daemon"\n`);
  await chmod(join(repoDir, "bin", opts.name), 0o755);
  await mkdir(join(repoDir, "services"), { recursive: true });
  await writeFile(
    join(repoDir, "services", `${opts.name}.service`),
    `[Service]\nExecStart={{BIN}}\n# nats={{NATS_URL}}\n`,
  );
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `name: ${opts.name}
version: 0.1.0
type: agent
tier: custom
targets: [linux-systemd]
identity:
  id: ${opts.name}
  displayName: ${opts.name}
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
  capabilities: [test]
provides:
  binary: bin/${opts.name}
  systemdUnit: services/${opts.name}.service
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

describe("install: linux-systemd multi-target dispatch", () => {
  test("standalone-bot install lands binary symlink + rendered unit, then daemon-reload + enable --now", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "alpha-bot" });
    const { runner, calls } = makeRecorder();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      hostOverrides: {
        "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" },
      },
      systemctlRunner: runner,
      lingerChecker: makeLingerChecker(true),
    });

    expect(result.success).toBe(true);

    const binLink = join(systemdBinDir, "alpha-bot");
    expect(existsSync(binLink)).toBe(true);

    const unitPath = join(unitDir, "alpha-bot.service");
    expect(existsSync(unitPath)).toBe(true);
    const unitContent = await readFile(unitPath, "utf-8");
    expect(unitContent).toContain(`ExecStart=${binLink}`);
    expect(unitContent).toContain("nats://");
    expect(unitContent).not.toContain("{{BIN}}");

    expect(calls).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "alpha-bot.service"],
    ]);
  });

  test("install records the package in the database", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "beta-bot" });
    const { runner } = makeRecorder();

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      hostOverrides: { "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" } },
      systemctlRunner: runner,
      lingerChecker: makeLingerChecker(true),
    });

    const row = getSkill(env.db, "beta-bot");
    expect(row).not.toBeNull();
    expect(row!.artifact_type).toBe("agent");
    expect(row!.status).toBe("active");
  });

  test("STOP-AND-ASK: linger disabled aborts the install with the exact sudo command, never invokes sudo", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "gamma-bot" });
    const { runner, calls } = makeRecorder();

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      hostOverrides: { "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" } },
      systemctlRunner: runner,
      lingerChecker: makeLingerChecker(false),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sudo loginctl enable-linger testuser/);
    // enable --now never called; the reload call is the only systemctl call recorded.
    expect(calls).toEqual([["--user", "daemon-reload"]]);

    // Rolled back cleanly.
    expect(existsSync(join(unitDir, "gamma-bot.service"))).toBe(false);
    expect(existsSync(join(systemdBinDir, "gamma-bot"))).toBe(false);
    expect(getSkill(env.db, "gamma-bot")).toBeNull();
  });

  test("postinstall failure rolls back the systemd side (unit disabled/removed, symlink gone)", async () => {
    const repoDir = join(env.root, "mock-delta-bot");
    await mkdir(join(repoDir, "bin"), { recursive: true });
    await writeFile(join(repoDir, "bin", "delta-bot"), "#!/bin/bash\n");
    await chmod(join(repoDir, "bin", "delta-bot"), 0o755);
    await mkdir(join(repoDir, "services"), { recursive: true });
    await writeFile(join(repoDir, "services", "delta-bot.service"), `[Service]\nExecStart={{BIN}}\n`);
    await mkdir(join(repoDir, "scripts"), { recursive: true });
    await writeFile(join(repoDir, "scripts", "fail.sh"), `#!/bin/bash\nexit 5\n`);
    await chmod(join(repoDir, "scripts", "fail.sh"), 0o755);
    await writeFile(
      join(repoDir, "arc-manifest.yaml"),
      `name: delta-bot
version: 0.1.0
type: agent
tier: custom
targets: [linux-systemd]
identity:
  id: delta-bot
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
provides:
  binary: bin/delta-bot
  systemdUnit: services/delta-bot.service
lifecycle:
  postinstall:
    - scripts/fail.sh
`,
    );
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const { runner, calls } = makeRecorder();
    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repoDir, yes: true,
      hostOverrides: { "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" } },
      systemctlRunner: runner,
      lingerChecker: makeLingerChecker(true),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Postinstall lifecycle script failed/);

    expect(existsSync(join(unitDir, "delta-bot.service"))).toBe(false);
    expect(existsSync(join(systemdBinDir, "delta-bot"))).toBe(false);
    // The install-transaction rollback (fired AFTER completeInstallTransaction
    // recorded the systemd side) disables the unit before deleting it.
    expect(calls).toContainEqual(["--user", "disable", "--now", "delta-bot.service"]);
    expect(getSkill(env.db, "delta-bot")).toBeNull();
  });
});
