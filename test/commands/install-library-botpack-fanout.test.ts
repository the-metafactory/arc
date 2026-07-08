/**
 * Library fan-out of cortex bot-packs (arc#244 / cortex#1133, the arc lane).
 *
 * THE BUG (cortex#129, verified end-to-end): `arc install <library>` of a
 * bundle whose members are `type: agent` bot-packs reported success and tracked
 * every member in the DB — but NEVER dropped the agents onto the stack. No
 * `agents.d/<id>.yaml`, no `personas/<id>.md` landed anywhere.
 *
 * Root cause: the library-member install path (`installSingleArtifact`) called
 * `createArtifactSymlinks` with `opts.host` (the claude-code default) and never
 * consulted `manifest.targets`. So a `type: agent` member targeting cortex took
 * the generic claude-code `.md` agent-symlink path, NOT the cortex bot-pack drop
 * (`agent.yaml → {configRoot}/agents.d/<id>.yaml` + `persona.md → …/personas/`).
 * The standalone path routes a `targets:`-declaring agent through
 * `installPerTarget` (which resolves the cortex host honoring
 * `hostOverrides.cortex.configRoot`); the library fan-out did not.
 *
 * These tests prove the fan-out now drops EACH member bot-pack onto the
 * targeted config-split stack subdir (honoring `--config-dir`'s configRoot),
 * scaffolds per-agent identity, and runs each member's postinstall.
 *
 * Parity guard: a library of plain skills (no `targets:`) must still land its
 * skills via the existing single-host path — unchanged.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createTestEnv, createMockLibraryRepo, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;
let cortexRootLegacy: string;

beforeEach(async () => {
  env = await createTestEnv();
  cortexRootLegacy = join(env.root, ".config", "cortex");
  await mkdir(cortexRootLegacy, { recursive: true });
  await writeFile(join(cortexRootLegacy, "cortex.yaml"), "# legacy single-file\n");
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

/** Scaffold a config-split stack dir under ~/.config/cortex/<slug>. */
async function scaffoldSplitStack(slug: string): Promise<string> {
  const stackDir = join(cortexRootLegacy, slug);
  await mkdir(join(stackDir, "system"), { recursive: true });
  await writeFile(join(stackDir, "system", "system.yaml"), "nats: {}\n");
  await mkdir(join(stackDir, "stacks"), { recursive: true });
  await writeFile(join(stackDir, "stacks", `${slug}.yaml`), `stack:\n  id: ${slug}\n`);
  await mkdir(join(stackDir, "agents.d"), { recursive: true });
  await mkdir(join(stackDir, "personas"), { recursive: true });
  await writeFile(join(stackDir, `${slug}.yaml`), "# pointer\n");
  return stackDir;
}

/**
 * A library bundle whose members are yarrow-shaped bot-packs
 * (agent.yaml + persona.md + lifecycle.postinstall, targets: [cortex]) —
 * the dev-loop bundle shape. Members are described by {name, id}.
 */
async function createBotPackLibraryRepo(opts: {
  libraryName: string;
  members: { name: string; id: string }[];
  logPath: string;
  /**
   * arc#281: when true, each member manifest declares `state: { blueprint,
   * version }`, opting the agent into the instance-state scaffold. Omit for a
   * stateless bot-pack (identity still provisioned, no instance dir).
   */
  withState?: boolean;
}): Promise<string> {
  const repoDir = join(env.root, `mock-lib-${opts.libraryName}`);
  await mkdir(repoDir, { recursive: true });

  // Root library manifest listing each member's subdir.
  const artifactLines = opts.members
    .map((m) => `  - path: agents/${m.id}\n    description: ${m.name} bot-pack`)
    .join("\n");
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `schema: arc/v1
name: ${opts.libraryName}
version: 1.0.0
type: library
description: bundle of bot-packs (dev-loop shape)
author:
  name: testuser
  github: testuser
artifacts:
${artifactLines}
`,
  );

  for (const m of opts.members) {
    const dir = join(repoDir, "agents", m.id);
    await mkdir(join(dir, "scripts"), { recursive: true });
    await mkdir(join(dir, "brain"), { recursive: true });
    await writeFile(
      join(dir, "agent.yaml"),
      `id: ${m.id}
displayName: "${m.name}"
persona: "../personas/${m.id}.md"
trust: []
presence: {}
runtime:
  mode: in-process
  capabilities: [soc.compose.flow]
  brain:
    kind: exec
    run: "bun {pack}/brain/main.ts"
    lifecycle: daemon
`,
    );
    await writeFile(join(dir, "persona.md"), `# ${m.name} persona\n`);
    await writeFile(join(dir, "brain", "main.ts"), `process.exit(0);\n`);
    await writeFile(
      join(dir, "scripts", "reload.sh"),
      `#!/bin/bash\necho "reload:${m.id}" >> "${opts.logPath}"\n`,
    );
    await writeFile(
      join(dir, "arc-manifest.yaml"),
      `schema: arc/v1
name: ${m.name}
version: 0.1.0
type: agent
tier: custom
description: ${m.name} bot-pack fixture
targets: [cortex]
${opts.withState ? `state:\n  blueprint: AgentState\n  version: ">=0.1.0"\n` : ""}lifecycle:
  postinstall:
    - scripts/reload.sh
`,
    );
  }

  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  commitAll(repoDir, "init");
  return repoDir;
}

function cortexOverrides(configRoot: string) {
  return {
    cortex: {
      configRoot,
      credsRoot: join(env.root, ".config", "nats", "creds"),
    },
  };
}

describe("library fan-out of cortex bot-packs (--config-dir)", () => {
  test("installs ALL member bot-packs onto the STACK SUBDIR (agents.d + personas), runs each postinstall", async () => {
    const stackDir = await scaffoldSplitStack("scratch");
    const logPath = join(env.root, "postinstall.log");
    const repo = await createBotPackLibraryRepo({
      libraryName: "dev-loop",
      members: [
        { name: "Dev", id: "dev" },
        { name: "Release", id: "release" },
        { name: "Approver", id: "approver" },
      ],
      logPath,
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo,
      yes: true,
      // What the CLI computes from `--config-dir <stackDir>`.
      hostOverrides: cortexOverrides(stackDir),
      cortexConfigEnv: { CORTEX_CONFIG: stackDir },
    });
    expect(result.success).toBe(true);
    expect(result.artifacts).toHaveLength(3);

    for (const id of ["dev", "release", "approver"]) {
      // Fragment lands INSIDE the stack subdir, as a symlink into the pack.
      const frag = join(stackDir, "agents.d", `${id}.yaml`);
      expect(existsSync(frag)).toBe(true);
      expect(lstatSync(frag).isSymbolicLink()).toBe(true);
      expect(await readFile(frag, "utf-8")).toContain(`id: ${id}`);
      // Persona beside it so the fragment's `../personas/<id>.md` resolves.
      expect(existsSync(join(stackDir, "personas", `${id}.md`))).toBe(true);
      // NOT at the legacy root.
      expect(existsSync(join(cortexRootLegacy, "agents.d", `${id}.yaml`))).toBe(false);
    }

    // Each member's postinstall ran after its drop.
    const log = await readFile(logPath, "utf-8");
    expect(log).toContain("reload:dev");
    expect(log).toContain("reload:release");
    expect(log).toContain("reload:approver");

    // All three tracked under the library name.
    for (const name of ["Dev", "Release", "Approver"]) {
      const row = getSkill(env.db, name);
      expect(row).toBeTruthy();
      expect(row!.library_name).toBe("dev-loop");
    }
  });

  test("scaffolds per-agent identity + instance state for a member WITH state (arc#281)", async () => {
    const stackDir = await scaffoldSplitStack("scratch2");
    const logPath = join(env.root, "postinstall2.log");
    // Redirect agent-state + nats seeds + provisioning sidecar into the test env
    // via the documented MF_INSTANCE_DIR / MF_NATS_DIR / MF_SIDECAR_DIR contract
    // so the real ~/.config location isn't touched. (Single member so the one
    // MF_INSTANCE_DIR maps unambiguously; the multi-member drop is proven above.)
    const instanceDir = join(env.root, "agent-state", "dev");
    const natsDir = join(env.root, ".config", "nats");
    const sidecarDir = join(env.root, ".config", "metafactory", "agents");

    // withState → the member opts into the instance-state scaffold (arc#281).
    const repo = await createBotPackLibraryRepo({
      libraryName: "dev-loop2",
      members: [{ name: "Dev", id: "dev" }],
      logPath,
      withState: true,
    });

    const prevNats = process.env.MF_NATS_DIR;
    const prevInstance = process.env.MF_INSTANCE_DIR;
    const prevSidecar = process.env.MF_SIDECAR_DIR;
    process.env.MF_NATS_DIR = natsDir;
    process.env.MF_INSTANCE_DIR = instanceDir;
    process.env.MF_SIDECAR_DIR = sidecarDir;
    try {
      const result = await install({
        arc: env.arc,
        host: env.host,
        db: env.db,
        repoUrl: repo,
        yes: true,
        hostOverrides: cortexOverrides(stackDir),
        cortexConfigEnv: { CORTEX_CONFIG: stackDir },
      });
      expect(result.success).toBe(true);

      // Per-agent NKey seed scaffolded under the redirected nats dir.
      expect(existsSync(join(natsDir, "dev.nk"))).toBe(true);
      // Instance state dir scaffolded (state.sqlite written inside it).
      expect(existsSync(instanceDir)).toBe(true);
      expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);
      // Sidecar (canonical provisioning record) written for the member too.
      expect(existsSync(join(sidecarDir, "dev.provision.json"))).toBe(true);
    } finally {
      if (prevNats === undefined) delete process.env.MF_NATS_DIR;
      else process.env.MF_NATS_DIR = prevNats;
      if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
      else process.env.MF_INSTANCE_DIR = prevInstance;
      if (prevSidecar === undefined) delete process.env.MF_SIDECAR_DIR;
      else process.env.MF_SIDECAR_DIR = prevSidecar;
    }
  });

  test("STATELESS member (no state): identity + sidecar, but NO instance dir (arc#281 fan-out gate)", async () => {
    const stackDir = await scaffoldSplitStack("scratch3");
    const logPath = join(env.root, "postinstall3.log");
    const instanceDir = join(env.root, "agent-state-stateless", "dev");
    const natsDir = join(env.root, ".config", "nats-stateless");
    const sidecarDir = join(env.root, ".config", "metafactory-stateless", "agents");

    // No withState → the member is stateless; the fan-out must gate the scaffold.
    const repo = await createBotPackLibraryRepo({
      libraryName: "dev-loop3",
      members: [{ name: "Dev", id: "dev" }],
      logPath,
    });

    const prevNats = process.env.MF_NATS_DIR;
    const prevInstance = process.env.MF_INSTANCE_DIR;
    const prevSidecar = process.env.MF_SIDECAR_DIR;
    process.env.MF_NATS_DIR = natsDir;
    process.env.MF_INSTANCE_DIR = instanceDir;
    process.env.MF_SIDECAR_DIR = sidecarDir;
    try {
      const result = await install({
        arc: env.arc,
        host: env.host,
        db: env.db,
        repoUrl: repo,
        yes: true,
        hostOverrides: cortexOverrides(stackDir),
        cortexConfigEnv: { CORTEX_CONFIG: stackDir },
      });
      expect(result.success).toBe(true);

      // Identity still provisioned for the stateless member.
      expect(existsSync(join(natsDir, "dev.nk"))).toBe(true);
      // Sidecar (canonical record) still written.
      expect(existsSync(join(sidecarDir, "dev.provision.json"))).toBe(true);
      // …but NO instance-state dir was scaffolded (the fan-out gates on state).
      expect(existsSync(instanceDir)).toBe(false);
    } finally {
      if (prevNats === undefined) delete process.env.MF_NATS_DIR;
      else process.env.MF_NATS_DIR = prevNats;
      if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
      else process.env.MF_INSTANCE_DIR = prevInstance;
      if (prevSidecar === undefined) delete process.env.MF_SIDECAR_DIR;
      else process.env.MF_SIDECAR_DIR = prevSidecar;
    }
  });
});

describe("library fan-out parity (no targets — single-host path unchanged)", () => {
  test("a library of plain skills still lands skills via the default host", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "skill-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "alpha"))).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "beta"))).toBe(true);
  });
});
