import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "fs/promises";
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
