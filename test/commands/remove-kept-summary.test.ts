import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("arc remove — owns kept-summary threading (arc#359)", () => {
  test("threads the owns declaration into the RemoveResult when declared", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Kept",
      owns: {
        config: ["~/.config/metafactory/kept"],
        state: ["~/.local/state/metafactory/kept"],
        userData: ["~/Developer/kept-workspace"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await remove(env.db, env.arc, env.host, "Kept", { yes: true });
    expect(result.success).toBe(true);
    expect(result.owns).toBeDefined();
    expect(result.owns?.config).toEqual(["~/.config/metafactory/kept"]);
    expect(result.owns?.userData).toEqual(["~/Developer/kept-workspace"]);
  });

  test("omits owns from the result when the package declares none (no behavior change)", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "Plain" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await remove(env.db, env.arc, env.host, "Plain", { yes: true });
    expect(result.success).toBe(true);
    expect(result.owns).toBeUndefined();
  });
});
