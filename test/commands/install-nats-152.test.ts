/**
 * arc#152 — install command must gate on a reachable NATS broker for
 * packages that declare `requires.nats: true`.
 *
 * Each test stubs the broker probe + spawn so the suite never opens a real
 * TCP socket or shells out to brew/systemctl. The aim is behavioral: did
 * install invoke the gate, and does it fail/succeed in the right shapes.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import {
  __setProbeForTests,
  __setSpawnRunnerForTests,
  __setPlatformForTests,
} from "../../src/lib/nats-broker.js";

let env: TestEnv;
let probeCalls: { host: string; port: number }[] = [];

beforeEach(async () => {
  env = await createTestEnv();
  probeCalls = [];
});

afterEach(async () => {
  __setProbeForTests(null);
  __setSpawnRunnerForTests(null);
  __setPlatformForTests(null);
  await env.cleanup();
});

describe("arc install — requires.nats gate (arc#152)", () => {
  test("packages WITHOUT requires.nats do not invoke the broker probe", async () => {
    // The gate must be opt-in. A plain skill install must never touch the
    // broker probe — that would be a behavioral regression for every
    // non-bus package in the ecosystem.
    __setProbeForTests(async (host, port) => {
      probeCalls.push({ host, port });
      return false;
    });

    const repo = await createMockSkillRepo(env.root, { name: "NoBusSkill" });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(probeCalls.length).toBe(0);
  });

  test("install proceeds when broker is reachable", async () => {
    __setProbeForTests(async (host, port) => {
      probeCalls.push({ host, port });
      return true;
    });

    const repo = await createMockSkillRepo(env.root, {
      name: "BusSkill",
      requires: { nats: true },
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(probeCalls).toEqual([{ host: "127.0.0.1", port: 4222 }]);
  });

  test("install aborts cleanly when remote NATS_URL is unreachable", async () => {
    // Operator explicitly asked for a remote broker. arc must NOT silently
    // bring up a local one — that would mask a real connectivity problem.
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "darwin");
    let spawned = false;
    __setSpawnRunnerForTests(() => {
      spawned = true;
      return { exitCode: 1, stdout: "", stderr: "should not be called" };
    });

    const origUrl = process.env.NATS_URL;
    process.env.NATS_URL = "nats://remote.example.com:4222";
    try {
      const repo = await createMockSkillRepo(env.root, {
        name: "BusSkillRemote",
        requires: { nats: true },
      });

      const result = await install({
        arc: env.arc,
        host: env.host,
        db: env.db,
        repoUrl: repo.url,
        yes: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("NATS broker");
      expect(result.error).toContain("nats://remote.example.com:4222");
      expect(spawned).toBe(false);
    } finally {
      if (origUrl === undefined) delete process.env.NATS_URL;
      else process.env.NATS_URL = origUrl;
    }
  });

  test("install rolls back the cloned repo when broker check fails", async () => {
    // Failing the broker gate must leave nothing behind under reposDir —
    // the same rollback discipline arc applies to other pre-symlink gates.
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "darwin");
    __setSpawnRunnerForTests((cmd) => {
      if (cmd[0] === "which" && cmd[1] === "brew") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: "unmocked" };
    });

    const repo = await createMockSkillRepo(env.root, {
      name: "BusSkillNoBrew",
      requires: { nats: true },
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Homebrew not found");

    // No DB row should exist for the aborted install.
    const row = env.db.prepare("SELECT * FROM skills WHERE name = ?").get("BusSkillNoBrew");
    expect(row).toBeNull();
  });
});
