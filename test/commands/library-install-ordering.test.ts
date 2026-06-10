import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { install } from "../../src/commands/install.js";
import { list } from "../../src/commands/list.js";
import { ArtifactInstallState } from "../../src/types.js";
import { createTestEnv, createMockLibraryRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#227 / F-6c: ordered library installs + atomic multi-artifact rollback.
 *
 * Exercises the four spec pillars through the real `install()` entrypoint:
 *   1. depends_on-ordered install (dependencies land before dependents)
 *   2. reverse-order rollback when an artifact fails mid-sequence
 *   3. partial-state reporting via the install journal
 *   4. resume semantics (retry from the failed artifact)
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/** A postinstall that always fails — simulates e.g. an unreachable broker. */
const FAILING_POSTINSTALL = {
  path: "scripts/postinstall.sh",
  content: "#!/usr/bin/env bash\necho 'simulated failure' >&2\nexit 1\n",
};

describe("library install ordering (arc#227)", () => {
  test("installs artifacts in dependency order, not declaration order", async () => {
    env = await createTestEnv();
    // Declaration order puts dependents BEFORE dependencies on purpose.
    const lib = await createMockLibraryRepo(env.root, {
      name: "dev-loop",
      artifacts: [
        { path: "agents/dev", name: "dev", type: "skill", dependsOn: ["pilot"] },
        { path: "agents/pilot", name: "pilot", type: "skill", dependsOn: ["agent-state"] },
        { path: "agents/agent-state", name: "agent-state", type: "skill" },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.journal).toBeDefined();

    const order = result.journal!.artifacts.map((a) => a.name);
    // agent-state before pilot before dev.
    expect(order.indexOf("agent-state")).toBeLessThan(order.indexOf("pilot"));
    expect(order.indexOf("pilot")).toBeLessThan(order.indexOf("dev"));
    expect(result.journal!.artifacts.every((a) => a.state === ArtifactInstallState.SUCCESS)).toBe(true);

    const installed = list(env.db);
    expect(installed.skills).toHaveLength(3);
  });

  test("rolls back all landed artifacts in reverse order when one fails", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "dev-loop",
      artifacts: [
        { path: "agents/agent-state", name: "agent-state", type: "skill" },
        { path: "agents/pilot", name: "pilot", type: "skill", dependsOn: ["agent-state"] },
        // dev fails in postinstall AFTER agent-state + pilot have landed.
        { path: "agents/dev", name: "dev", type: "skill", dependsOn: ["pilot"], postinstall: FAILING_POSTINSTALL },
        { path: "agents/release", name: "release", type: "skill", dependsOn: ["dev"] },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("dev");
    expect(result.error).toContain("Rolled back");

    // Atomic: nothing remains installed — agent-state + pilot were unwound.
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(0);

    // Atomic at the FILESYSTEM layer too — symlinks for the landed artifacts
    // are gone, not just their DB rows.
    expect(existsSync(join(env.host.paths.skillsDir, "agent-state"))).toBe(false);
    expect(existsSync(join(env.host.paths.skillsDir, "pilot"))).toBe(false);

    // Journal records the rollback shape: the two that landed are rolled_back,
    // dev is failed, release was never attempted (absent from journal).
    const states = Object.fromEntries(
      result.journal!.artifacts.map((a) => [a.name, a.state]),
    );
    expect(states["agent-state"]).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states.pilot).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states.dev).toBe(ArtifactInstallState.FAILED);
    expect(states.release).toBeUndefined();
  });

  test("stops the sequence on first failure — later artifacts are never attempted", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "lib",
      artifacts: [
        { path: "a/first", name: "first", type: "skill", postinstall: FAILING_POSTINSTALL },
        { path: "a/second", name: "second", type: "skill", dependsOn: ["first"] },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
    });

    expect(result.success).toBe(false);
    const names = result.journal!.artifacts.map((a) => a.name);
    expect(names).toEqual(["first"]); // 'second' never reached
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(0);
  });

  test("resume installs only from the named artifact onward", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "dev-loop",
      artifacts: [
        { path: "agents/agent-state", name: "agent-state", type: "skill" },
        { path: "agents/pilot", name: "pilot", type: "skill", dependsOn: ["agent-state"] },
        { path: "agents/dev", name: "dev", type: "skill", dependsOn: ["pilot"] },
      ],
    });

    // Pre-install agent-state + pilot the normal way by filtering to each.
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true, artifactName: "agent-state" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true, artifactName: "pilot" });

    let installed = list(env.db);
    expect(installed.skills.map((s) => s.name).sort()).toEqual(["agent-state", "pilot"]);

    // Resume from dev — the two earlier artifacts are skipped (already active).
    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
      resumeFromArtifact: "dev",
    });

    expect(result.success).toBe(true);
    const devDetail = result.journal!.artifacts.find((a) => a.name === "dev");
    expect(devDetail?.state).toBe(ArtifactInstallState.SUCCESS);
    // agent-state + pilot are not even in the resumed journal (started at dev).
    expect(result.journal!.artifacts.map((a) => a.name)).toEqual(["dev"]);

    installed = list(env.db);
    expect(installed.skills.map((s) => s.name).sort()).toEqual(["agent-state", "dev", "pilot"]);
  });

  test("resume rejects an unknown artifact name", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "lib",
      artifacts: [{ path: "a/alpha", name: "alpha", type: "skill" }],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
      resumeFromArtifact: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Resume artifact 'nonexistent' not found");
  });

  test("reports a dependency cycle without touching the filesystem", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "cyclic",
      artifacts: [
        { path: "a/x", name: "x", type: "skill", dependsOn: ["y"] },
        { path: "a/y", name: "y", type: "skill", dependsOn: ["x"] },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle/i);
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(0);
  });

  test("already-installed artifacts are skipped (not re-installed, not rolled back)", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "lib",
      artifacts: [
        { path: "a/alpha", name: "alpha", type: "skill" },
        { path: "a/beta", name: "beta", type: "skill", dependsOn: ["alpha"] },
      ],
    });

    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true });

    const result2 = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true,
    });

    expect(result2.success).toBe(true);
    expect(result2.journal!.artifacts.every((a) => a.state === ArtifactInstallState.SKIPPED)).toBe(true);
    const installed = list(env.db);
    expect(installed.skills).toHaveLength(2); // not duplicated
  });
});
