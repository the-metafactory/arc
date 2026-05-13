/**
 * Tests for arc#140 P5: arc remove honors lifecycle.preuninstall +
 * multi-target uninstall ordering (supervision hosts FIRST, registry LAST).
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
import { remove } from "../../src/commands/remove.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;
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

const hostOverrides = () => ({
  cortex: {
    configRoot: cortexRoot,
    credsRoot: join(env.root, ".config", "nats", "creds"),
  },
  "darwin-launchd": {
    plistDir: launchdPlistDir,
    binDir: launchdBinDir,
    forcePlatform: "darwin" as const,
  },
});

async function makeStandaloneBotRepo(opts: {
  name: string;
  lifecycle?: {
    preuninstall?: Array<{ path: string; content: string }>;
    postuninstall?: Array<{ path: string; content: string }>;
  };
}): Promise<{ url: string }> {
  const repoDir = join(env.root, `mock-${opts.name}`);
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    join(repoDir, `${opts.name}.md`),
    `---\nname: ${opts.name}\n---\n# ${opts.name}\n`,
  );
  await mkdir(join(repoDir, "bin"), { recursive: true });
  await writeFile(join(repoDir, "bin", opts.name), `#!/bin/bash\n`);
  await chmod(join(repoDir, "bin", opts.name), 0o755);
  await mkdir(join(repoDir, "services"), { recursive: true });
  await writeFile(
    join(repoDir, "services", `ai.meta-factory.${opts.name}.plist`),
    `<plist></plist>`,
  );

  if (opts.lifecycle) {
    for (const phase of Object.values(opts.lifecycle)) {
      if (!phase) continue;
      for (const s of phase) {
        const p = join(repoDir, s.path);
        await mkdir(join(p, ".."), { recursive: true });
        await writeFile(p, s.content);
        await chmod(p, 0o755);
      }
    }
  }

  const lifecycleYaml = opts.lifecycle
    ? `lifecycle:
${Object.entries(opts.lifecycle)
  .filter(([, arr]) => arr && arr.length > 0)
  .map(([phase, arr]) => `  ${phase}:\n${arr!.map((s) => `    - ${s.path}`).join("\n")}`)
  .join("\n")}
`
    : "";

  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `name: ${opts.name}
version: 0.1.0
type: agent
tier: custom
targets: [cortex, darwin-launchd]
identity:
  id: ${opts.name}
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
provides:
  files:
    - source: ${opts.name}.md
      target: ~/.config/cortex/agents.d/${opts.name}.md
  binary: bin/${opts.name}
  plist: services/ai.meta-factory.${opts.name}.plist
${lifecycleYaml}`,
  );

  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  return { url: repoDir };
}

async function installBot(name: string, lifecycle?: any) {
  const repo = await makeStandaloneBotRepo({ name, lifecycle });
  // Override env HOME so provides.files (~/.config/...) lands inside env.root
  // — without this, sage-shape installs leak into the developer's real ~/.
  const originalHome = process.env.HOME;
  process.env.HOME = env.root;
  try {
    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
      hostOverrides: hostOverrides(),
    });
    return result;
  } finally {
    process.env.HOME = originalHome;
  }
}

async function removeBot(name: string) {
  const originalHome = process.env.HOME;
  process.env.HOME = env.root;
  try {
    return await remove(env.db, env.arc, env.host, name, {
      quiet: true,
      hostOverrides: hostOverrides(),
    });
  } finally {
    process.env.HOME = originalHome;
  }
}

describe("remove: multi-target uninstall", () => {
  test("multi-target remove unlinks cortex fragment + launchd binary + plist", async () => {
    await installBot("alpha-bot");

    // Verify installed
    const cortexLink = join(cortexRoot, "agents.d", "alpha-bot.md");
    const binLink = join(launchdBinDir, "alpha-bot");
    const plistPath = join(launchdPlistDir, "ai.meta-factory.alpha-bot.plist");
    expect(existsSync(cortexLink)).toBe(true);
    expect(existsSync(binLink)).toBe(true);
    expect(existsSync(plistPath)).toBe(true);

    const result = await removeBot("alpha-bot");
    expect(result.success).toBe(true);

    expect(existsSync(cortexLink)).toBe(false);
    expect(existsSync(binLink)).toBe(false);
    expect(existsSync(plistPath)).toBe(false);
    expect(getSkill(env.db, "alpha-bot")).toBeNull();
  });

  test("lifecycle.preuninstall runs in declared order BEFORE artifacts are removed", async () => {
    const logPath = join(env.root, "preuninstall-log.txt");
    const checkPath = join(env.root, "preuninstall-saw.txt");
    await installBot("beta-bot", {
      preuninstall: [
        {
          path: "scripts/01-stop.sh",
          content: `#!/bin/bash
echo "stop" >> "${logPath}"
# Capture cortex fragment + launchd plist presence at preuninstall time —
# the design contract says both must still be on disk.
[ -e "${join(cortexRoot, "agents.d", "beta-bot.md")}" ] && echo "cortex=present" >> "${checkPath}"
[ -e "${join(launchdPlistDir, "ai.meta-factory.beta-bot.plist")}" ] && echo "plist=present" >> "${checkPath}"
`,
        },
        {
          path: "scripts/02-drain.sh",
          content: `#!/bin/bash\necho "drain" >> "${logPath}"\n`,
        },
        {
          path: "scripts/03-signal.sh",
          content: `#!/bin/bash\necho "signal" >> "${logPath}"\n`,
        },
      ],
    });

    const result = await removeBot("beta-bot");
    expect(result.success).toBe(true);

    const log = await readFile(logPath, "utf-8");
    expect(log).toBe("stop\ndrain\nsignal\n");
    const check = await readFile(checkPath, "utf-8");
    expect(check).toContain("cortex=present");
    expect(check).toContain("plist=present");
  });

  test("lifecycle.preuninstall failure aborts remove; artifacts stay on disk", async () => {
    await installBot("gamma-bot", {
      preuninstall: [
        { path: "scripts/ok.sh", content: `#!/bin/bash\nexit 0\n` },
        { path: "scripts/fail.sh", content: `#!/bin/bash\nexit 5\n` },
      ],
    });

    const result = await removeBot("gamma-bot");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Preuninstall lifecycle script failed.*scripts\/fail\.sh/);

    // Artifacts remain
    expect(existsSync(join(cortexRoot, "agents.d", "gamma-bot.md"))).toBe(true);
    expect(existsSync(join(launchdBinDir, "gamma-bot"))).toBe(true);
    expect(existsSync(join(launchdPlistDir, "ai.meta-factory.gamma-bot.plist"))).toBe(true);

    // DB row remains
    expect(getSkill(env.db, "gamma-bot")).not.toBeNull();
  });

  test("supervision target unlinks BEFORE registry target (reverse install order)", async () => {
    const orderPath = join(env.root, "remove-order.txt");
    await installBot("delta-bot", {
      preuninstall: [
        {
          path: "scripts/probe.sh",
          content: `#!/bin/bash
# At preuninstall time everything is still in place — record initial state.
echo "preuninstall: cortex=$([ -e "${join(cortexRoot, "agents.d", "delta-bot.md")}" ] && echo yes || echo no) plist=$([ -e "${join(launchdPlistDir, "ai.meta-factory.delta-bot.plist")}" ] && echo yes || echo no)" >> "${orderPath}"
`,
        },
      ],
      postuninstall: [
        {
          path: "scripts/probe-after.sh",
          content: `#!/bin/bash
echo "postuninstall: cortex=$([ -e "${join(cortexRoot, "agents.d", "delta-bot.md")}" ] && echo yes || echo no) plist=$([ -e "${join(launchdPlistDir, "ai.meta-factory.delta-bot.plist")}" ] && echo yes || echo no)" >> "${orderPath}"
`,
        },
      ],
    });

    await removeBot("delta-bot");
    const log = await readFile(orderPath, "utf-8");
    expect(log).toContain("preuninstall: cortex=yes plist=yes");
    expect(log).toContain("postuninstall: cortex=no plist=no");
  });

  test("lifecycle.postuninstall runs AFTER artifacts are removed", async () => {
    const seenPath = join(env.root, "post-saw.txt");
    await installBot("epsilon-bot", {
      postuninstall: [
        {
          path: "scripts/check-gone.sh",
          content: `#!/bin/bash
# Cortex fragment must already be gone by the time this runs.
if [ ! -e "${join(cortexRoot, "agents.d", "epsilon-bot.md")}" ]; then
  echo "gone" > "${seenPath}"
fi
`,
        },
      ],
    });

    const result = await removeBot("epsilon-bot");
    expect(result.success).toBe(true);
    expect(existsSync(seenPath)).toBe(true);
    const seen = await readFile(seenPath, "utf-8");
    expect(seen.trim()).toBe("gone");
  });

  test("legacy single-target remove path unaffected (regression check)", async () => {
    // type:skill, no targets → existing path
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
    expect(existsSync(join(env.host.paths.skillsDir, "LegacySkill"))).toBe(true);

    const result = await remove(env.db, env.arc, env.host, "LegacySkill", { quiet: true });
    expect(result.success).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "LegacySkill"))).toBe(false);
    expect(getSkill(env.db, "LegacySkill")).toBeNull();
  });
});
