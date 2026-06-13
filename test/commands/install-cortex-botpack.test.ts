/**
 * Cortex bot-pack install (cortex#1021 W-4; design-bot-packs.md §4 +
 * design-arc-agent-bots.md §6.2/§8.1).
 *
 * A `type: agent, targets: [cortex]` pack whose root carries `agent.yaml` +
 * `persona.md` (the yarrow shape) must land:
 *
 *   agent.yaml → {configRoot}/agents.d/<id>.yaml   (id from the fragment)
 *   persona.md → {configRoot}/personas/<id>.md
 *
 * and run the pack's `lifecycle.postinstall` scripts AFTER the drop (the
 * §8.1 ordering: drop fragment → signal reload → issue creds — the scripts
 * stand in for `cortex agents reload` / `cortex creds issue` here).
 *
 * The legacy standalone-bot shape (no agent.yaml; fragment via
 * provides.files) is covered by install-multitarget-i140.test.ts and must
 * stay on the old path — pinned below.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;
let cortexRoot: string;

beforeEach(async () => {
  env = await createTestEnv();
  cortexRoot = join(env.root, ".config", "cortex");
  await mkdir(join(cortexRoot, "agents.d"), { recursive: true });
  await mkdir(join(cortexRoot, "personas"), { recursive: true });
  await writeFile(join(cortexRoot, "cortex.yaml"), "# fake cortex.yaml\n");
});

afterEach(async () => {
  await env.cleanup();
});

function commitAll(repoDir: string, message: string): void {
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", message],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
}

/** A yarrow-shaped bot pack: agent.yaml + persona.md + lifecycle scripts. */
async function createBotPackRepo(opts: {
  parent: string;
  name: string;
  fragmentId: string;
  logPath: string;
  omitPersona?: boolean;
}): Promise<{ url: string; dir: string }> {
  const repoDir = join(opts.parent, `mock-${opts.name}`);
  await mkdir(join(repoDir, "scripts"), { recursive: true });
  await mkdir(join(repoDir, "brain"), { recursive: true });
  await writeFile(
    join(repoDir, "agent.yaml"),
    `id: ${opts.fragmentId}
displayName: "${opts.name} — Composer"
persona: "../personas/${opts.fragmentId}.md"
trust: []
presence: {}
runtime:
  mode: in-process
  capabilities:
    - soc.compose.flow
  brain:
    kind: exec
    run: "bun {pack}/brain/main.ts"
    lifecycle: daemon
`,
  );
  if (opts.omitPersona !== true) {
    await writeFile(join(repoDir, "persona.md"), `# ${opts.name} persona\n`);
  }
  await writeFile(join(repoDir, "brain", "main.ts"), `process.exit(0);\n`);
  await writeFile(
    join(repoDir, "scripts", "signal-cortex-reload.sh"),
    `#!/bin/bash\necho "reload" >> "${opts.logPath}"\n`,
  );
  await writeFile(
    join(repoDir, "scripts", "issue-nats-creds.sh"),
    `#!/bin/bash\necho "creds" >> "${opts.logPath}"\n`,
  );
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `name: ${opts.name}
version: 0.1.0
type: agent
tier: custom
description: bot pack fixture
targets: [cortex]
lifecycle:
  postinstall:
    - scripts/signal-cortex-reload.sh
    - scripts/issue-nats-creds.sh
`,
  );
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  commitAll(repoDir, "init");
  return { url: repoDir, dir: repoDir };
}

function cortexOverrides(): { cortex: { configRoot: string; credsRoot: string } } {
  return {
    cortex: {
      configRoot: cortexRoot,
      credsRoot: join(env.root, ".config", "nats", "creds"),
    },
  };
}

describe("install: cortex bot pack (agent.yaml shape)", () => {
  test("fragment + persona land under the fragment's id; postinstall runs after the drop", async () => {
    const logPath = join(env.root, "postinstall.log");
    const repo = await createBotPackRepo({
      parent: env.root,
      name: "Yarrow",
      fragmentId: "yarrow",
      logPath,
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      hostOverrides: cortexOverrides(),
    });
    expect(result.success).toBe(true);

    // Fragment named after the fragment's id (NOT the display-cased manifest
    // name) in agents.d/, as a symlink into the install dir.
    const fragmentLink = join(cortexRoot, "agents.d", "yarrow.yaml");
    expect(existsSync(fragmentLink)).toBe(true);
    expect(lstatSync(fragmentLink).isSymbolicLink()).toBe(true);
    expect(await readFile(fragmentLink, "utf-8")).toContain("id: yarrow");

    // Persona beside it, so the fragment's relative `../personas/yarrow.md`
    // resolves from agents.d/.
    const personaLink = join(cortexRoot, "personas", "yarrow.md");
    expect(existsSync(personaLink)).toBe(true);
    expect(await readFile(personaLink, "utf-8")).toContain("persona");

    // §8.1 ordering — both postinstall scripts ran, reload before creds.
    expect(await readFile(logPath, "utf-8")).toBe("reload\ncreds\n");

    // One DB row under the manifest name.
    expect(getSkill(env.db, "Yarrow")).toBeTruthy();
  });

  test("persona.md is optional — fragment alone installs", async () => {
    const logPath = join(env.root, "postinstall2.log");
    const repo = await createBotPackRepo({
      parent: env.root,
      name: "Sparse",
      fragmentId: "sparse",
      logPath,
      omitPersona: true,
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
      hostOverrides: cortexOverrides(),
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(cortexRoot, "agents.d", "sparse.yaml"))).toBe(true);
    expect(existsSync(join(cortexRoot, "personas", "sparse.md"))).toBe(false);
  });

  test("path-traversal id is an install ERROR — nothing lands anywhere", async () => {
    const logPath = join(env.root, "postinstall4.log");
    const repo = await createBotPackRepo({
      parent: env.root,
      name: "Evil",
      fragmentId: "ignored",
      logPath,
    });
    // A PRESENT-but-unsafe id is an install ERROR — silently renaming the
    // fragment under a fallback stem would install an identity whose id
    // contradicts its filename (sage round 2). Nothing may land anywhere.
    await writeFile(
      join(repo.dir, "agent.yaml"),
      `id: "../../outside/evil"\ndisplayName: "Escape"\n`,
    );
    commitAll(repo.dir, "evil id");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
      hostOverrides: cortexOverrides(),
    });
    expect(result.success).toBe(false);
    expect(existsSync(join(cortexRoot, "agents.d", "evil.yaml"))).toBe(false);
    expect(existsSync(join(env.root, ".config", "outside"))).toBe(false);
    expect(existsSync(join(cortexRoot, "outside"))).toBe(false);
  });

  test("ABSENT agent.yaml id falls back to the lowercased manifest name", async () => {
    const logPath = join(env.root, "postinstall3.log");
    const repo = await createBotPackRepo({
      parent: env.root,
      name: "Fallback",
      fragmentId: "ignored",
      logPath,
    });
    // Overwrite with a fragment that has no usable id (ABSENT id — the only
    // case where the manifest-name fallback applies).
    await writeFile(join(repo.dir, "agent.yaml"), `displayName: "No Id Here"\n`);
    commitAll(repo.dir, "no id");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
      hostOverrides: cortexOverrides(),
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(cortexRoot, "agents.d", "fallback.yaml"))).toBe(true);
  });
});
