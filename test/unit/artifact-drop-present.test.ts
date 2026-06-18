import { describe, test, expect, afterEach } from "bun:test";
import { rm, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  artifactDropPresent,
  createArtifactSymlinks,
  planArtifactSymlinks,
} from "../../src/lib/artifact-installer.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";
import type { ArcManifest } from "../../src/types.js";

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/**
 * arc#248: the install-time path computation must live in ONE place
 * (planArtifactSymlinks). The verifier (artifactDropPresent) and the applier
 * (createArtifactSymlinks) both consume it. These tests pin that the PLAN and
 * the APPLY agree on the exact target set, and that the verifier reads
 * filesystem-truth (not the DB).
 */
describe("planArtifactSymlinks ⇄ createArtifactSymlinks parity", () => {
  // Each row builds a real package on disk for `type`, applies it, and asserts
  // the set of symlink targets the apply step actually created equals the set
  // the planner predicted. This guards against plan/apply drift.
  const cases: {
    type: "skill" | "tool" | "agent" | "prompt";
    withCli?: boolean;
  }[] = [
    { type: "skill" },
    { type: "skill", withCli: true },
    { type: "tool" },
    { type: "agent" },
    { type: "prompt" },
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
      const manifest = (await import("../../src/lib/manifest.js")).readManifest;
      const m = (await manifest(repo.path))!;

      const planned = planArtifactSymlinks({
        type: m.type,
        manifest: m,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      });

      const applied = await createArtifactSymlinks({
        type: m.type,
        manifest: m,
        arc: env.arc,
        host: env.host,
        installDir: repo.path,
      });

      const plannedTargets = new Set(planned.symlinkTargets.map((s) => s.target));
      const appliedTargets = new Set(applied.record.symlinks);
      expect(appliedTargets).toEqual(plannedTargets);

      // Every predicted target exists on disk after apply.
      for (const t of plannedTargets) {
        expect(existsSync(t)).toBe(true);
      }

      // Shim names match too.
      expect(new Set(applied.record.shims.names)).toEqual(new Set(planned.shimNames));
    });
  }
});

describe("artifactDropPresent", () => {
  test("true when the drop is present, false after the symlink is removed", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, { name: "present-skill" });
    const m = (await import("../../src/lib/manifest.js")).readManifest;
    const manifest = (await m(repo.path))!;

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
    const m = (await import("../../src/lib/manifest.js")).readManifest;
    const manifest = (await m(repo.path))!;

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
    const m = (await import("../../src/lib/manifest.js")).readManifest;
    const manifest = (await m(repo.path))!;

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
