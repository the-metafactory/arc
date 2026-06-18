/**
 * S1 (arc#244 / cortex#1133) — `arc install` targeting a config-split stack.
 *
 * A config-split cortex stack lives at `~/.config/cortex/<stack>/` (a pointer
 * file + `system/system.yaml`, `stacks/`, `agents.d/`, `personas/`). Before S1
 * arc's cortex host rooted `agents.d/` + `personas/` at `~/.config/cortex` (the
 * LEGACY single-file root), so a bot-pack installed onto a real config-split
 * deployment landed its fragment + persona OUTSIDE the stack dir the daemon
 * loads.
 *
 * These end-to-end tests drive `install()` with a cortex `configRoot` pointing
 * at the STACK SUBDIR (what the CLI computes from `--config-dir` / `--stack`)
 * and assert the fragment + persona land INSIDE it — and, in the no-flag
 * control case, at the legacy root (byte-identical default).
 *
 * The path-resolution unit contract (legacy / --config-dir / --stack, pointer
 * dirname, traversal guards) lives in test/unit/cortex-config-split.test.ts;
 * here we prove the resolved configRoot actually steers where artifacts land.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { resolveCortexConfigRoot } from "../../src/lib/hosts/cortex-config-split.js";
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
  // The pointer (sentinel) file the daemon's --config points at.
  await writeFile(join(stackDir, `${slug}.yaml`), "# pointer\n");
  return stackDir;
}

/** A yarrow-shaped bot pack: agent.yaml + persona.md, targets: [cortex]. */
async function createBotPackRepo(name: string, fragmentId: string): Promise<string> {
  const repoDir = join(env.root, `mock-${name}`);
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    join(repoDir, "agent.yaml"),
    `id: ${fragmentId}
displayName: "${name}"
persona: "../personas/${fragmentId}.md"
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
  await writeFile(join(repoDir, "persona.md"), `# ${name} persona\n`);
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    `name: ${name}
version: 0.1.0
type: agent
tier: custom
description: bot pack fixture
targets: [cortex]
`,
  );
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

describe("install onto a config-split stack (--stack / --config-dir)", () => {
  test("--stack <name>: fragment + persona land in the STACK SUBDIR, not the legacy root", async () => {
    const stackDir = await scaffoldSplitStack("meta-factory");
    const repo = await createBotPackRepo("Yarrow", "yarrow");

    // What the CLI computes from `--stack meta-factory`.
    const resolved = resolveCortexConfigRoot({ stack: "meta-factory", home: env.root });
    expect(resolved.configRoot).toBe(stackDir);

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo,
      yes: true,
      hostOverrides: cortexOverrides(resolved.configRoot!),
    });
    expect(result.success).toBe(true);

    // Lands INSIDE the stack subdir…
    const fragInStack = join(stackDir, "agents.d", "yarrow.yaml");
    expect(existsSync(fragInStack)).toBe(true);
    expect(lstatSync(fragInStack).isSymbolicLink()).toBe(true);
    expect(existsSync(join(stackDir, "personas", "yarrow.md"))).toBe(true);

    // …and NOT at the legacy root.
    expect(existsSync(join(cortexRootLegacy, "agents.d", "yarrow.yaml"))).toBe(false);
    expect(existsSync(join(cortexRootLegacy, "personas", "yarrow.md"))).toBe(false);

    expect(getSkill(env.db, "Yarrow")).toBeTruthy();
  });

  test("--config-dir <pointer-file>: resolves to dirname and lands there", async () => {
    const stackDir = await scaffoldSplitStack("research");
    const pointer = join(stackDir, "research.yaml");
    const repo = await createBotPackRepo("Sage", "sage");

    const resolved = resolveCortexConfigRoot({ configDir: pointer, home: env.root });
    expect(resolved.configRoot).toBe(stackDir);

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo,
      yes: true,
      hostOverrides: cortexOverrides(resolved.configRoot!),
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(stackDir, "agents.d", "sage.yaml"))).toBe(true);
    expect(existsSync(join(cortexRootLegacy, "agents.d", "sage.yaml"))).toBe(false);
  });

  test("no flag (control): default configRoot lands at the legacy ~/.config/cortex root — unchanged", async () => {
    // Legacy root needs agents.d/personas to receive the drop.
    await mkdir(join(cortexRootLegacy, "agents.d"), { recursive: true });
    await mkdir(join(cortexRootLegacy, "personas"), { recursive: true });
    const repo = await createBotPackRepo("Echo", "echo");

    // No flags → undefined configRoot → caller keeps default cortex root.
    const resolved = resolveCortexConfigRoot({ home: env.root });
    expect(resolved.configRoot).toBeUndefined();

    // The CLI uses the legacy root as the cortex configRoot when no flag set.
    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo,
      yes: true,
      hostOverrides: cortexOverrides(cortexRootLegacy),
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(cortexRootLegacy, "agents.d", "echo.yaml"))).toBe(true);
  });
});
