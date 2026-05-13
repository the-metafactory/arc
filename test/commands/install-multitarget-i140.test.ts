/**
 * Integration tests for arc#140 P3: multi-target install dispatch.
 *
 * Verifies that:
 *   - manifest.targets routes installation through resolveHost()
 *   - cortex target lands the agent fragment into ~/.config/cortex/agents.d/
 *   - darwin-launchd target lands the binary symlink + rendered plist
 *   - ordering invariant holds (cortex BEFORE darwin-launchd)
 *   - install failures roll back launchd-side state cleanly
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod, readFile } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;
/** Temp roots for the cortex + launchd adapters. */
let cortexRoot: string;
let launchdPlistDir: string;
let launchdBinDir: string;

beforeEach(async () => {
  env = await createTestEnv();
  cortexRoot = join(env.root, ".config", "cortex");
  launchdPlistDir = join(env.root, "Library", "LaunchAgents");
  launchdBinDir = join(env.root, "bin");
  await mkdir(join(cortexRoot, "agents.d"), { recursive: true });
  await mkdir(launchdPlistDir, { recursive: true });
  await mkdir(launchdBinDir, { recursive: true });
  await writeFile(join(cortexRoot, "cortex.yaml"), "# fake cortex.yaml\n");
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * Create a sage-shape standalone-bot repo with cortex + darwin-launchd
 * targets. The agent persona is at <repo>/sage.md per arc-installable
 * shape; the binary is at bin/<name>, the plist at services/<label>.plist.
 */
async function createStandaloneBotRepo(opts: {
  parent: string;
  name: string;
}): Promise<{ url: string }> {
  const repoDir = join(opts.parent, `mock-${opts.name}`);
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    join(repoDir, `${opts.name}.md`),
    `---\nname: ${opts.name}\ndescription: Mock bot\n---\n\n# ${opts.name}\n`,
  );
  await mkdir(join(repoDir, "bin"), { recursive: true });
  await writeFile(
    join(repoDir, "bin", opts.name),
    `#!/bin/bash\necho "${opts.name} daemon"\n`,
  );
  await chmod(join(repoDir, "bin", opts.name), 0o755);
  await mkdir(join(repoDir, "services"), { recursive: true });
  await writeFile(
    join(repoDir, "services", `ai.meta-factory.${opts.name}.plist`),
    `<plist><dict><key>Label</key><string>ai.meta-factory.${opts.name}</string><key>BinaryPath</key><string>{{BIN}}</string><key>NATS</key><string>{{NATS_URL}}</string></dict></plist>`,
  );
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `name: ${opts.name}
version: 0.1.0
type: agent
tier: custom
targets: [cortex, darwin-launchd]
identity:
  id: ${opts.name}
  displayName: ${opts.name}
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
  capabilities: [test]
provides:
  files:
    - source: ${opts.name}.md
      target: ~/.config/cortex/agents.d/${opts.name}.md
  binary: bin/${opts.name}
  plist: services/ai.meta-factory.${opts.name}.plist
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

describe("install: multi-target dispatch", () => {
  test("standalone-bot install lands cortex + darwin-launchd artifacts", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "alpha-bot" });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      hostOverrides: {
        cortex: { configRoot: cortexRoot, credsRoot: join(env.root, ".config", "nats", "creds") },
        "darwin-launchd": { plistDir: launchdPlistDir, binDir: launchdBinDir, forcePlatform: "darwin" },
      },
    });

    expect(result.success).toBe(true);

    // cortex side — agent fragment + provides.files
    const cortexLink = join(cortexRoot, "agents.d", "alpha-bot.md");
    expect(existsSync(cortexLink)).toBe(true);

    // launchd side — binary symlink + rendered plist
    const binLink = join(launchdBinDir, "alpha-bot");
    expect(existsSync(binLink)).toBe(true);

    const plistPath = join(launchdPlistDir, "ai.meta-factory.alpha-bot.plist");
    expect(existsSync(plistPath)).toBe(true);

    const plistContent = await readFile(plistPath, "utf-8");
    expect(plistContent).toContain(`BinaryPath</key><string>${binLink}`);
    expect(plistContent).toContain("nats://");
    expect(plistContent).not.toContain("{{BIN}}");
    expect(plistContent).not.toContain("{{NATS_URL}}");
  });

  test("install records the package in the database (single DB row, even with multi-target)", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "beta-bot" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      hostOverrides: {
        cortex: { configRoot: cortexRoot, credsRoot: join(env.root, ".config", "nats", "creds") },
        "darwin-launchd": { plistDir: launchdPlistDir, binDir: launchdBinDir, forcePlatform: "darwin" },
      },
    });

    const row = getSkill(env.db, "beta-bot");
    expect(row).not.toBeNull();
    expect(row!.artifact_type).toBe("agent");
    expect(row!.status).toBe("active");
  });

  test("postinstall failure rolls back BOTH cortex and launchd artifacts", async () => {
    const repoDir = join(env.root, "mock-gamma-bot");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "gamma-bot.md"), "# gamma-bot persona\n");
    await mkdir(join(repoDir, "bin"), { recursive: true });
    await writeFile(join(repoDir, "bin", "gamma-bot"), "#!/bin/bash\n");
    await chmod(join(repoDir, "bin", "gamma-bot"), 0o755);
    await mkdir(join(repoDir, "services"), { recursive: true });
    await writeFile(
      join(repoDir, "services", "ai.meta-factory.gamma-bot.plist"),
      `<plist></plist>`,
    );
    await mkdir(join(repoDir, "scripts"), { recursive: true });
    await writeFile(join(repoDir, "scripts", "fail.sh"), `#!/bin/bash\nexit 5\n`);
    await chmod(join(repoDir, "scripts", "fail.sh"), 0o755);

    await writeFile(
      join(repoDir, "arc-manifest.yaml"),
      `name: gamma-bot
version: 0.1.0
type: agent
tier: custom
targets: [cortex, darwin-launchd]
identity:
  id: gamma-bot
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
provides:
  files:
    - source: gamma-bot.md
      target: ~/.config/cortex/agents.d/gamma-bot.md
  binary: bin/gamma-bot
  plist: services/ai.meta-factory.gamma-bot.plist
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

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repoDir, yes: true,
      hostOverrides: {
        cortex: { configRoot: cortexRoot, credsRoot: join(env.root, ".config", "nats", "creds") },
        "darwin-launchd": { plistDir: launchdPlistDir, binDir: launchdBinDir, forcePlatform: "darwin" },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Postinstall lifecycle script failed/);

    // Both sides rolled back
    expect(existsSync(join(cortexRoot, "agents.d", "gamma-bot.md"))).toBe(false);
    expect(existsSync(join(launchdBinDir, "gamma-bot"))).toBe(false);
    expect(existsSync(join(launchdPlistDir, "ai.meta-factory.gamma-bot.plist"))).toBe(false);

    // No DB row
    expect(getSkill(env.db, "gamma-bot")).toBeNull();
  });

  test("cortex target installs BEFORE darwin-launchd (ordering verified via mtime)", async () => {
    const repo = await createStandaloneBotRepo({ parent: env.root, name: "delta-bot" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      hostOverrides: {
        cortex: { configRoot: cortexRoot, credsRoot: join(env.root, ".config", "nats", "creds") },
        "darwin-launchd": { plistDir: launchdPlistDir, binDir: launchdBinDir, forcePlatform: "darwin" },
      },
    });

    const { stat } = await import("fs/promises");
    const cortexMtime = (await stat(join(cortexRoot, "agents.d", "delta-bot.md"))).mtimeMs;
    const plistMtime = (await stat(join(launchdPlistDir, "ai.meta-factory.delta-bot.plist"))).mtimeMs;

    // cortex symlink was created first; plist after.
    expect(cortexMtime).toBeLessThanOrEqual(plistMtime);
  });

  test("manifest without targets uses legacy single-host path (regression check)", async () => {
    // A type:skill package — no targets — should land via env.host (claude-code) as before.
    const repoDir = join(env.root, "mock-legacy-skill");
    await mkdir(join(repoDir, "skill"), { recursive: true });
    await writeFile(
      join(repoDir, "skill", "SKILL.md"),
      `---\nname: LegacySkill\n---\n\n# LegacySkill\n`,
    );
    await writeFile(
      join(repoDir, "arc-manifest.yaml"),
      `name: LegacySkill
version: 1.0.0
type: skill
tier: custom
provides:
  skill:
    - trigger: legacyskill
capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: false
  secrets: []
`,
    );
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repoDir, yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "LegacySkill"))).toBe(true);
  });
});
