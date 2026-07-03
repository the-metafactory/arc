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

describe("Soma skill projection lifecycle (arc#251)", () => {
  test("projects installed skills through soma and unprojects on remove", async () => {
    const callsPath = join(env.root, "soma-calls.log");
    const somaPath = join(env.arc.shimDir, "soma");
    await mkdir(env.arc.shimDir, { recursive: true });
    await writeFile(
      somaPath,
      `#!/bin/sh\necho "$@" >> "${callsPath}"\nexit 0\n`,
    );
    await chmod(somaPath, 0o755);
    process.env.ARC_SOMA_BIN = somaPath;

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
});
