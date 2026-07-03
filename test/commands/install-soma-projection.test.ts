import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import {
  createMockSkillRepo,
  createTestEnv,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
import { runSomaSkillProjection } from "../../src/lib/soma-projection.js";
import type { ArcManifest } from "../../src/types.js";

let env: TestEnv;
let originalSomaBin: string | undefined;

beforeEach(async () => {
  env = await createTestEnv();
  originalSomaBin = process.env.ARC_SOMA_BIN;
});

afterEach(async () => {
  if (originalSomaBin === undefined) {
    delete process.env.ARC_SOMA_BIN;
  } else {
    process.env.ARC_SOMA_BIN = originalSomaBin;
  }
  await env.cleanup();
});

async function writeFakeSoma(
  scriptForCallsPath: (callsPath: string) => string,
  callsFile = "soma-calls.log",
) {
  const callsPath = join(env.root, callsFile);
  const somaPath = join(env.arc.shimDir, "soma");
  await mkdir(env.arc.shimDir, { recursive: true });
  await writeFile(somaPath, scriptForCallsPath(callsPath));
  await chmod(somaPath, 0o755);
  process.env.ARC_SOMA_BIN = somaPath;
  return { callsPath, somaPath };
}

describe("Soma skill projection lifecycle (arc#251)", () => {
  test("projects installed skills through soma and unprojects on remove", async () => {
    const { callsPath } = await writeFakeSoma(
      (path) => `#!/bin/sh\necho "$@" >> "${path}"\nexit 0\n`,
    );

    const repo = await createMockSkillRepo(env.root, {
      name: "ProjectedSkill",
    });

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });
    expect(installed.success).toBe(true);

    const removed = await remove(env.db, env.arc, env.host, "ProjectedSkill", { yes: true });
    expect(removed.success).toBe(true);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      expect.stringMatching(/^project-skill .+\/skill --apply$/),
      expect.stringMatching(/^unproject-skill .+\/skill --apply$/),
    ]);
  });

  test("missing soma does not fail skill installation", async () => {
    process.env.ARC_SOMA_BIN = join(env.root, "missing-soma");
    const repo = await createMockSkillRepo(env.root, {
      name: "NoSomaSkill",
    });

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(installed.success).toBe(true);
  });

  test("failed soma projection does not claim landed evidence", async () => {
    const { callsPath } = await writeFakeSoma(
      (path) =>
        `#!/bin/sh\necho "$@" >> "${path}"\necho "projection failed" >&2\nexit 12\n`,
      "soma-failed-calls.log",
    );

    const repo = await createMockSkillRepo(env.root, {
      name: "PartialProjectionSkill",
    });

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(installed.success).toBe(true);
    expect(installed.evidence?.landedArtifacts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "soma-projection" })]),
    );

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      expect.stringMatching(/^project-skill .+\/skill --apply$/),
    ]);
  });

  test("failed soma projection caps stderr in warning text", async () => {
    const noisyStderr = "x".repeat(9000);
    const { callsPath } = await writeFakeSoma(
      (path) =>
        `#!/bin/sh\necho "$@" >> "${path}"\nprintf '%s' '${noisyStderr}' >&2\nexit 12\n`,
      "soma-noisy-calls.log",
    );
    const installPath = join(env.root, "noisy-package");
    await mkdir(join(installPath, "skill"), { recursive: true });

    const manifest: ArcManifest = {
      name: "NoisyProjectionSkill",
      version: "1.0.0",
      type: "skill",
      tier: "custom",
      provides: {
        skill: [{ trigger: "noisyprojection" }],
      },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    };

    const result = await runSomaSkillProjection({
      manifest,
      installPath,
      mode: "project",
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.warning).toContain("[stderr truncated after 8192 bytes]");
    expect(result.warning!.length).toBeLessThan(8400);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      expect.stringMatching(/^project-skill .+\/skill --apply$/),
    ]);
  });

  test("remove --yes still warns when soma unprojection is unavailable", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "WarnOnRemove",
    });
    process.env.ARC_SOMA_BIN = join(env.root, "missing-soma");

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });
    expect(installed.success).toBe(true);

    let stderr = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    };
    try {
      const removed = await remove(env.db, env.arc, env.host, "WarnOnRemove", { yes: true });
      expect(removed.success).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderr).toContain("soma unproject-skill unavailable");
    expect(stderr).toContain("continuing without Soma projection");
  });
});
