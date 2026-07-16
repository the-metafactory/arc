/**
 * Integration tests for arc#311 (L2): multi-target install dispatch for
 * linux-systemd. Sister to install-multitarget-i140.test.ts (darwin-launchd).
 *
 * RENDER-ONLY design (principal decision, PR #314 review): install lands
 * `provides.binary` (symlink), `provides.systemdUnit` (rendered), then
 * `systemctl --user daemon-reload` — nothing more. Activation is the
 * package's own `lifecycle.postinstall` concern (parity with darwin).
 *
 * NEVER spawns a real `systemctl` — `install()`'s injectable
 * `systemctlRunner` is threaded through `installPerTarget` ->
 * `installSystemdArtifacts` -> `completeInstallTransaction` for every
 * test here, mirroring how `hostOverrides` isolates paths.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod, readFile } from "fs/promises";
import { join } from "path";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";
import type { SystemctlRunner, SystemctlResult } from "../../src/lib/hosts/systemd-install.js";

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
  test("standalone-bot install lands binary symlink + rendered unit, then daemon-reload only (no enable)", async () => {
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

    // ONLY daemon-reload -- render-only design, no enable/disable/linger call.
    expect(calls).toEqual([["--user", "daemon-reload"]]);
  });

  test("install records the package in the database", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "beta-bot" });
    const { runner } = makeRecorder();

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      hostOverrides: { "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" } },
      systemctlRunner: runner,
    });

    const row = getSkill(env.db, "beta-bot");
    expect(row).not.toBeNull();
    expect(row!.artifact_type).toBe("agent");
    expect(row!.status).toBe("active");
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
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Postinstall lifecycle script failed/);

    expect(existsSync(join(unitDir, "delta-bot.service"))).toBe(false);
    expect(existsSync(join(systemdBinDir, "delta-bot"))).toBe(false);
    // The install-transaction rollback (fired AFTER completeInstallTransaction
    // recorded the systemd side) still `disable --now`s defensively before
    // deleting the unit -- arc owns teardown symmetrically even though
    // install itself never enabled anything (the package's own postinstall
    // is what would have, and it's what just failed).
    expect(calls).toContainEqual(["--user", "disable", "--now", "delta-bot.service"]);
    expect(getSkill(env.db, "delta-bot")).toBeNull();
  });

  test("detect-gate (PR #314 review, root-cause fix): a host with no systemd user session fails cleanly BEFORE any disk mutation", async () => {
    // forcePlatform: "darwin" makes createLinuxSystemdHost's detect() return
    // false regardless of unitDir existing (the adapter's detect() is
    // `onLinux && existsSync(unitDir)`) -- exactly the "targets:
    // [linux-systemd] reached real systemd dispatch on macOS" scenario the
    // reviewer's repro demonstrated. Before this fix, dispatch never
    // consulted host.detect() at all and would spawn a real `systemctl`.
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "epsilon-bot" });
    const { runner, calls } = makeRecorder();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      hostOverrides: {
        "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "darwin" },
      },
      systemctlRunner: runner,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /linux-systemd target requires a systemd user session \(systemctl \+ ~\/\.config\/systemd\/user\); not available on this host/,
    );

    // Zero disk mutation: no binary symlink, no unit file, no systemctl call.
    expect(existsSync(join(unitDir, "epsilon-bot.service"))).toBe(false);
    expect(existsSync(join(systemdBinDir, "epsilon-bot"))).toBe(false);
    expect(calls.length).toBe(0);
    expect(getSkill(env.db, "epsilon-bot")).toBeNull();
  });
});
