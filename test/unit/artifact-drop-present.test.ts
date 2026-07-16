import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, rm, unlink, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  artifactDropPresent,
  createArtifactSymlinks,
  planArtifactSymlinks,
  type ArtifactSymlinkOpts,
} from "../../src/lib/artifact-installer.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";
import { resolveHost } from "../../src/lib/hosts/registry.js";
import { readManifest } from "../../src/lib/manifest.js";
import type { ArcManifest, HostAdapter } from "../../src/types.js";
import { installSystemdArtifacts, type SystemctlRunner } from "../../src/lib/hosts/systemd-install.js";
import { installLaunchdArtifacts } from "../../src/lib/hosts/launchd-install.js";

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/**
 * Assert that the APPLY step (createArtifactSymlinks) creates EXACTLY the
 * target set + shim names the PLAN (planArtifactSymlinks) predicts — and that
 * every predicted target exists on disk afterward. This guards against the
 * plan and apply drifting (arc#248 single-source-of-truth invariant).
 */
async function assertParity(opts: ArtifactSymlinkOpts): Promise<void> {
  const planned = planArtifactSymlinks(opts);
  const applied = await createArtifactSymlinks(opts);

  const plannedTargets = new Set(planned.symlinkTargets.map((s) => s.target));
  const appliedTargets = new Set(applied.record.symlinks);
  expect(appliedTargets).toEqual(plannedTargets);

  for (const t of plannedTargets) {
    expect(existsSync(t)).toBe(true);
  }
  expect(new Set(applied.record.shims.names)).toEqual(new Set(planned.shimNames));
}

/**
 * arc#248: the install-time path computation must live in ONE place
 * (planArtifactSymlinks). The verifier (artifactDropPresent) and the applier
 * (createArtifactSymlinks) both consume it. These tests pin that the PLAN and
 * the APPLY agree on the exact target set, and that the verifier reads
 * filesystem-truth (not the DB).
 *
 * Coverage goal: every branch of the planArtifactSymlinks `switch` — skill
 * (+CLI), tool, agent (legacy .md AND the cortex bot-pack agent.yaml branch),
 * prompt, action, component, pipeline, plus a provides.files-bearing case.
 */
describe("planArtifactSymlinks ⇄ createArtifactSymlinks parity", () => {
  // claude-code-host artifact types the mock-repo helper can scaffold.
  const cases: {
    type: "skill" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "action";
    withCli?: boolean;
  }[] = [
    { type: "skill" },
    { type: "skill", withCli: true },
    { type: "tool" },
    { type: "agent" },
    { type: "prompt" },
    { type: "component" },
    { type: "pipeline" },
    { type: "pipeline", withCli: true },
    { type: "action" },
  ];

  for (const c of cases) {
    const label = `${c.type}${c.withCli ? " (with CLI)" : ""}`;
    test(`apply creates exactly what the planner predicts: ${label}`, async () => {
      env = await createTestEnv();
      const repo = await createMockSkillRepo(env.root, {
        name: `parity-${c.type}${c.withCli ? "-cli" : ""}`,
        type: c.type,
        withCli: c.withCli,
      });
      const m = (await readManifest(repo.path))!;

      await assertParity({
        type: m.type,
        manifest: m,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      });
    });
  }

  test("apply creates exactly what the planner predicts: skill with provides.files", async () => {
    env = await createTestEnv();
    const auxTarget = join(env.root, "aux", "helper.ts");
    const repo = await createMockSkillRepo(env.root, {
      name: "parity-files",
      files: [{ source: "extra/helper.ts", target: auxTarget, content: "// helper\n" }],
    });
    const m = (await readManifest(repo.path))!;

    await assertParity({
      type: m.type,
      manifest: m,
      arc: env.arc,
      host: env.host,
      installDir: repo.path,
    });
    // The provides.files target specifically must have landed.
    expect(existsSync(auxTarget)).toBe(true);
  });

  test("apply creates exactly what the planner predicts: cortex bot-pack (agent.yaml + persona.md)", async () => {
    // The arc#248/dev-loop-critical branch: host.id==='cortex' && agent.yaml
    // at the pack root → agents.d/<id>.yaml + personas/<id>.md, with the id
    // resolved from the fragment's `id:` field via resolveBotPackAgentId. This
    // is the only complex/throwing branch — it MUST be parity-checked.
    env = await createTestEnv();
    const cortexRoot = join(env.root, ".config", "cortex");
    await mkdir(join(cortexRoot, "agents.d"), { recursive: true });
    await mkdir(join(cortexRoot, "personas"), { recursive: true });
    await writeFile(join(cortexRoot, "cortex.yaml"), "# fake cortex.yaml\n");

    const packDir = join(env.root, "mock-botpack");
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, "agent.yaml"),
      `id: petal\ndisplayName: "Petal — Composer"\npersona: "../personas/petal.md"\n`,
    );
    await writeFile(join(packDir, "persona.md"), "# Petal persona\n");
    await writeFile(
      join(packDir, "arc-manifest.yaml"),
      `name: Petal\nversion: 0.1.0\ntype: agent\ntier: custom\ntargets: [cortex]\n`,
    );

    const cortexHost: HostAdapter = resolveHost("cortex", {
      cortex: {
        configRoot: cortexRoot,
        credsRoot: join(env.root, ".config", "nats", "creds"),
      },
    });
    const m = (await readManifest(packDir))!;

    await assertParity({
      type: m.type,
      manifest: m,
      arc: env.arc,
      host: cortexHost,
      installDir: packDir,
    });

    // Concretely: the planner targeted exactly the fragment + persona under
    // the fragment id (not the display-cased manifest name).
    const planned = planArtifactSymlinks({
      type: m.type,
      manifest: m,
      arc: env.arc,
      host: cortexHost,
      installDir: packDir,
    });
    expect(new Set(planned.symlinkTargets.map((s) => s.target))).toEqual(
      new Set([
        join(cortexRoot, "agents.d", "petal.yaml"),
        join(cortexRoot, "personas", "petal.md"),
      ]),
    );
  });

  test("planArtifactSymlinks throws on an unsafe bot-pack id (matches apply)", async () => {
    // resolveBotPackAgentId rejects a path-traversal id — the planner must
    // throw the SAME way the apply step would, so artifactDropPresent treats
    // such a recorded-active member as not-present (re-install, surface error).
    env = await createTestEnv();
    const cortexRoot = join(env.root, ".config", "cortex");
    await mkdir(join(cortexRoot, "agents.d"), { recursive: true });
    await writeFile(join(cortexRoot, "cortex.yaml"), "# fake\n");

    const packDir = join(env.root, "mock-evil");
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, "agent.yaml"), `id: "../../outside/evil"\ndisplayName: "Escape"\n`);
    await writeFile(
      join(packDir, "arc-manifest.yaml"),
      `name: Evil\nversion: 0.1.0\ntype: agent\ntier: custom\ntargets: [cortex]\n`,
    );

    const cortexHost = resolveHost("cortex", {
      cortex: { configRoot: cortexRoot, credsRoot: join(env.root, ".config", "nats", "creds") },
    });
    const m = (await readManifest(packDir))!;

    expect(() =>
      planArtifactSymlinks({ type: m.type, manifest: m, arc: env.arc, host: cortexHost, installDir: packDir }),
    ).toThrow(/unsafe id/);

    // And artifactDropPresent swallows the throw → not-present.
    expect(
      await artifactDropPresent({
        type: m.type,
        manifest: m,
        arc: env.arc,
        host: cortexHost,
        installDir: packDir,
        hostOverrides: {
          cortex: { configRoot: cortexRoot, credsRoot: join(env.root, ".config", "nats", "creds") },
        },
      }),
    ).toBe(false);
  });
});

describe("artifactDropPresent", () => {
  test("true when the drop is present, false after the symlink is removed", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, { name: "present-skill" });
    const manifest = (await readManifest(repo.path))!;

    await createArtifactSymlinks({
      type: manifest.type,
      manifest,
      arc: env.arc,
      host: env.host,
      installDir: repo.path,
    });

    // Present immediately after install.
    expect(
      await artifactDropPresent({
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      }),
    ).toBe(true);

    // Wipe the host-side symlink — DB-truth would still say "active", but the
    // filesystem drop is gone.
    await unlink(join(env.host.paths.skillsDir, "present-skill"));
    expect(
      await artifactDropPresent({
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      }),
    ).toBe(false);
  });

  test("false when the symlink dangles (target removed)", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, { name: "dangle-skill" });
    const manifest = (await readManifest(repo.path))!;

    await createArtifactSymlinks({
      type: manifest.type,
      manifest,
      arc: env.arc,
      host: env.host,
      installDir: repo.path,
    });

    // Remove the SOURCE the symlink points at — the symlink is now dangling.
    await rm(join(repo.path, "skill"), { recursive: true, force: true });
    expect(
      await artifactDropPresent({
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      }),
    ).toBe(false);
  });

  test("rules packages have no host drop — always present", async () => {
    env = await createTestEnv();
    const manifest: ArcManifest = {
      name: "rules-pkg",
      version: "1.0.0",
      type: "rules",
    };
    expect(
      await artifactDropPresent({
        type: "rules",
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: join(env.root, "nonexistent"),
      }),
    ).toBe(true);
  });

  test("provides.files target presence is verified", async () => {
    env = await createTestEnv();
    const aux = join(env.root, "aux-target.ts");
    const repo = await createMockSkillRepo(env.root, {
      name: "files-skill",
      files: [{ source: "extra/helper.ts", target: aux, content: "// helper\n" }],
    });
    const manifest = (await readManifest(repo.path))!;

    await createArtifactSymlinks({
      type: manifest.type,
      manifest,
      arc: env.arc,
      host: env.host,
      installDir: repo.path,
    });
    expect(
      await artifactDropPresent({
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      }),
    ).toBe(true);

    // Remove the provides.files target → not present.
    await unlink(aux);
    expect(
      await artifactDropPresent({
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      }),
    ).toBe(false);
  });
});

/**
 * arc#250 (v2 fix, closed alongside arc#311): a manifest whose `targets` is
 * ONLY supervision hosts (darwin-launchd / linux-systemd) used to resolve to
 * an EMPTY registry-host list, so the verify loop ran zero checks and
 * `artifactDropPresent` returned `true` UNCONDITIONALLY — a wiped plist/unit
 * read as "present". These tests pin the fix: supervision targets now get a
 * real presence check (rendered unit/plist + binary symlink), and the
 * fail-safe backstop never lets an empty-checks run report "present".
 */
describe("artifactDropPresent — arc#250 supervision-host regression", () => {
  const noopRunner: SystemctlRunner = async () => ({ code: 0, stderr: "" });

  test("linux-systemd-only manifest: present after install, false after the unit is wiped (was: always true)", async () => {
    env = await createTestEnv();
    const unitDir = join(env.root, ".config", "systemd", "user");
    const binDir = join(env.root, "systemd-bin");
    await mkdir(unitDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const installDir = join(env.root, "mock-sysd-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(join(installDir, "bin", "sysd-bot"), "#!/bin/bash\n");
    await chmod(join(installDir, "bin", "sysd-bot"), 0o755);
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(join(installDir, "services", "sysd-bot.service"), `[Service]\nExecStart={{BIN}}\n`);

    const manifest: ArcManifest = {
      name: "sysd-bot",
      version: "0.1.0",
      type: "agent",
      targets: ["linux-systemd"],
      provides: { binary: "bin/sysd-bot", systemdUnit: "services/sysd-bot.service" },
    };

    const host = resolveHost("linux-systemd", {
      "linux-systemd": { unitDir, binDir, forcePlatform: "linux" },
    });
    await installSystemdArtifacts({
      host: host as HostAdapter & { paths: { unitDir: string; binDir: string } },
      manifest,
      installDir,
      quiet: true,
      systemctlRunner: noopRunner,
      lingerChecker: async () => ({ enabled: true, username: "test" }),
    });

    const hostOverrides = { "linux-systemd": { unitDir, binDir, forcePlatform: "linux" as const } };

    // Present immediately after install — BEFORE the fix this was already
    // `true`, but for the WRONG reason (zero checks ran).
    expect(
      await artifactDropPresent({
        type: "agent",
        manifest,
        arc: env.arc,
        host: env.host,
        installDir,
        hostOverrides,
      }),
    ).toBe(true);

    // Wipe the rendered unit — the DB row would still say "active".
    await unlink(join(unitDir, "sysd-bot.service"));
    expect(
      await artifactDropPresent({
        type: "agent",
        manifest,
        arc: env.arc,
        host: env.host,
        installDir,
        hostOverrides,
      }),
    ).toBe(false);
  });

  test("darwin-launchd-only manifest: present after install, false after the plist is wiped", async () => {
    env = await createTestEnv();
    const plistDir = join(env.root, "Library", "LaunchAgents");
    const binDir = join(env.root, "launchd-bin");
    await mkdir(plistDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const installDir = join(env.root, "mock-launchd-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(join(installDir, "bin", "launchd-bot"), "#!/bin/bash\n");
    await chmod(join(installDir, "bin", "launchd-bot"), 0o755);
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(join(installDir, "services", "launchd-bot.plist"), `<plist></plist>`);

    const manifest: ArcManifest = {
      name: "launchd-bot",
      version: "0.1.0",
      type: "agent",
      targets: ["darwin-launchd"],
      provides: { binary: "bin/launchd-bot", plist: "services/launchd-bot.plist" },
    };

    const host = resolveHost("darwin-launchd", {
      "darwin-launchd": { plistDir, binDir, forcePlatform: "darwin" },
    });
    await installLaunchdArtifacts({
      host: host as HostAdapter & { paths: { plistDir: string; binDir: string } },
      manifest,
      installDir,
      quiet: true,
    });

    const hostOverrides = { "darwin-launchd": { plistDir, binDir, forcePlatform: "darwin" as const } };

    expect(
      await artifactDropPresent({
        type: "agent",
        manifest,
        arc: env.arc,
        host: env.host,
        installDir,
        hostOverrides,
      }),
    ).toBe(true);

    await unlink(join(plistDir, "launchd-bot.plist"));
    expect(
      await artifactDropPresent({
        type: "agent",
        manifest,
        arc: env.arc,
        host: env.host,
        installDir,
        hostOverrides,
      }),
    ).toBe(false);
  });

  test("regression: a supervision-only artifact whose unit was wiped re-drops on reinstall (skip-guard consults the real fix)", async () => {
    // This is the exact arc#250 scenario the skip-on-active install guard
    // hits: a manifest with `targets: [linux-systemd]` gets recorded active,
    // its unit is later wiped (e.g. a manual `rm`), and a re-install must
    // NOT silently skip because artifactDropPresent still says "present".
    env = await createTestEnv();
    const unitDir = join(env.root, ".config", "systemd", "user");
    const binDir = join(env.root, "systemd-bin");
    await mkdir(unitDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const installDir = join(env.root, "mock-resurrect-bot");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(join(installDir, "services", "resurrect-bot.service"), `[Service]\nExecStart=/bin/true\n`);

    const manifest: ArcManifest = {
      name: "resurrect-bot",
      version: "0.1.0",
      type: "agent",
      targets: ["linux-systemd"],
      provides: { systemdUnit: "services/resurrect-bot.service" },
    };
    const hostOverrides = { "linux-systemd": { unitDir, binDir, forcePlatform: "linux" as const } };
    const host = resolveHost("linux-systemd", hostOverrides);
    await installSystemdArtifacts({
      host: host as HostAdapter & { paths: { unitDir: string; binDir: string } },
      manifest,
      installDir,
      quiet: true,
      systemctlRunner: noopRunner,
      lingerChecker: async () => ({ enabled: true, username: "test" }),
    });

    // Simulate the wipe.
    await unlink(join(unitDir, "resurrect-bot.service"));

    // The skip-on-active install guard is exactly `artifactDropPresent` —
    // it must report `false` so the caller re-runs install instead of
    // silently trusting the stale "active" DB row.
    expect(
      await artifactDropPresent({
        type: "agent",
        manifest,
        arc: env.arc,
        host: env.host,
        installDir,
        hostOverrides,
      }),
    ).toBe(false);
  });
});
