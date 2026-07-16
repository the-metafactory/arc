/**
 * Tests for findOrphanedSystemdUnits (arc#311, hardened per PR #314
 * adversarial review MINOR (b)): the first cut flagged EVERY `.service`
 * file in unitDir not claimed by a currently-active package — including a
 * user's own unrelated, hand-written unit arc never touched. The fix
 * scopes flagging to units a DB-known arc package (active OR disabled)
 * declares via `provides.systemdUnit`; a basename with no DB record at
 * all is never flagged.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { findOrphanedSystemdUnits } from "../../src/commands/verify.js";
import { updateSkillStatus, removeSkill } from "../../src/lib/db.js";
import { resolveHost } from "../../src/lib/hosts/registry.js";
import type { SystemctlRunner, SystemctlResult, LingerChecker } from "../../src/lib/hosts/systemd-install.js";

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
  const runner: SystemctlRunner = async (args) => responses[args.join(" ")] ?? { code: 0, stderr: "" };
  return runner;
}

function makeLingerChecker(enabled: boolean): LingerChecker {
  return async () => ({ enabled, username: "testuser" });
}

async function installBot(name: string) {
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
  return install({
    arc: env.arc, host: env.host, db: env.db, repoUrl: repoDir, yes: true,
    hostOverrides: { "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" } },
    systemctlRunner: makeRecorder(),
    lingerChecker: makeLingerChecker(true),
  });
}

function systemdHost() {
  return resolveHost("linux-systemd", {
    "linux-systemd": { unitDir, binDir: systemdBinDir, forcePlatform: "linux" },
  });
}

describe("findOrphanedSystemdUnits", () => {
  test("an actively-installed package's own unit is never flagged", async () => {
    const result = await installBot("active-bot");
    expect(result.success).toBe(true);

    const orphans = await findOrphanedSystemdUnits(env.db, systemdHost());
    expect(orphans.map((o) => o.unitPath)).not.toContain(join(unitDir, "active-bot.service"));
  });

  test("a user's unrelated hand-written unit is NEVER flagged (PR #314 MINOR fix)", async () => {
    await installBot("active-bot");
    // A unit arc never rendered, with no DB record of any kind.
    await writeFile(join(unitDir, "personal-timer.service"), `[Service]\nExecStart=/bin/true\n`);

    const orphans = await findOrphanedSystemdUnits(env.db, systemdHost());
    expect(orphans.map((o) => o.unitPath)).not.toContain(join(unitDir, "personal-timer.service"));
  });

  test("a disabled (but still DB-known) package's dangling unit IS flagged", async () => {
    await installBot("disabled-bot");
    updateSkillStatus(env.db, "disabled-bot", "disabled");
    // The unit file itself is untouched by disable (disable doesn't tear
    // down the systemd side) -- it's now a DB-known-but-inactive dangler.

    const orphans = await findOrphanedSystemdUnits(env.db, systemdHost());
    expect(orphans.map((o) => o.unitPath)).toContain(join(unitDir, "disabled-bot.service"));
  });

  test("KNOWN GAP (documented tradeoff): once the DB row is fully removed, its leftover unit is no longer flagged", async () => {
    await installBot("removed-bot");
    // Simulate an interrupted `arc remove` that dropped the DB row but left
    // the unit file behind -- once the row is gone, this scan has no way
    // to know the file was ever arc's. Documented in findOrphanedSystemdUnits'
    // doc comment as the accepted tradeoff for never false-positiving on a
    // user's unrelated unit.
    removeSkill(env.db, "removed-bot");

    const orphans = await findOrphanedSystemdUnits(env.db, systemdHost());
    expect(orphans.map((o) => o.unitPath)).not.toContain(join(unitDir, "removed-bot.service"));
  });

  test("empty / missing unitDir returns no orphans", async () => {
    const host = resolveHost("linux-systemd", {
      "linux-systemd": { unitDir: join(env.root, "does-not-exist"), binDir: systemdBinDir, forcePlatform: "linux" },
    });
    expect(await findOrphanedSystemdUnits(env.db, host)).toEqual([]);
  });
});
