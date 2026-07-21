import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";
import { list } from "../../src/commands/list.js";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * arc#354: an already-installed dependency is the SUCCESS case, not a failure.
 *
 * Live repro: `arc install quest-master` declared
 * `depends_on.packages: [{ name: "agent-state", repo: … }]` while the installed
 * row's manifest name was `AgentState`. The dependency loop's name-only lookup
 * missed the row, the recursive install() then tripped its duplicate guard, and
 * the whole install aborted mid-way ("Failed to install dependency
 * 'agent-state': Skill 'AgentState' is already installed (status: active)") —
 * leaving the clone on disk but no skill projection.
 *
 * The fix: resolve the installed dependency by declared name OR repo URL,
 * treat active-with-drop-present as satisfied, check a declared compat range
 * with the arc#284 warn-don't-fail posture, and make install()'s duplicate
 * guards return a no-op success for active rows instead of an error.
 */
describe("install — already-installed depends_on.packages is satisfied (arc#354)", () => {
  test("dependency already installed under a DIFFERENT manifest name → satisfied, install proceeds", async () => {
    // The dependency's manifest name (and DB row) is "AgentStateX"…
    const dep = await createMockSkillRepo(env.root, { name: "AgentStateX", version: "1.0.0" });
    const pre = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: dep.url, yes: true });
    expect(pre.success).toBe(true);

    // …but the dependent declares it under a slugged alias (the live-repro
    // shape: `agent-state` vs `AgentState`), matched via the repo URL.
    const pkg = await createMockSkillRepo(env.root, {
      name: "QuestPkg",
      version: "1.0.0",
      dependsOnPackages: [{ name: "agent-state-x", repo: dep.url }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkg.url, yes: true });

    // Pre-fix this failed with "Failed to install dependency 'agent-state-x':
    // Skill 'AgentStateX' is already installed (status: active)".
    expect(result.success).toBe(true);
    expect(result.name).toBe("QuestPkg");

    // The dependent's own projection landed (no half-installed state).
    expect(existsSync(join(env.host.paths.skillsDir, "QuestPkg"))).toBe(true);
    // The dependency was left exactly as it was.
    expect(getSkill(env.db, "AgentStateX")?.version).toBe("1.0.0");
    expect(list(env.db).skills).toHaveLength(2);
  });

  test("dependency already installed under the SAME name → satisfied, install proceeds", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "DepSame", version: "1.2.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: dep.url, yes: true });

    const pkg = await createMockSkillRepo(env.root, {
      name: "PkgSame",
      version: "1.0.0",
      dependsOnPackages: [{ name: "DepSame", repo: dep.url }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkg.url, yes: true });
    expect(result.success).toBe(true);
    expect(getSkill(env.db, "PkgSame")?.status).toBe("active");
    expect(getSkill(env.db, "DepSame")?.version).toBe("1.2.0");
  });

  test("name-mismatched dependency with a MISSING drop is re-dropped (arc#248 path via repo-URL match)", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "AgentStateY", version: "1.0.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: dep.url, yes: true });

    // Wipe the dependency's host drop; DB row stays active (arc#248 shape).
    const depLink = join(env.host.paths.skillsDir, "AgentStateY");
    expect(existsSync(depLink)).toBe(true);
    await unlink(depLink);

    const pkg = await createMockSkillRepo(env.root, {
      name: "QuestPkgY",
      version: "1.0.0",
      dependsOnPackages: [{ name: "agent-state-y", repo: dep.url }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkg.url, yes: true });
    expect(result.success).toBe(true);

    // The dependency's drop is back, re-recorded under its manifest name —
    // the stale row was removed by its RECORDED name (not the declared
    // alias), so no duplicate row survives.
    expect(existsSync(depLink)).toBe(true);
    expect(getSkill(env.db, "AgentStateY")?.status).toBe("active");
    expect(list(env.db).skills).toHaveLength(2);
  });

  test("declared version range SATISFIED by the installed dependency → silent proceed", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "DepInRange", version: "1.5.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: dep.url, yes: true });

    const pkg = await createMockSkillRepo(env.root, {
      name: "PkgInRange",
      version: "1.0.0",
      dependsOnPackages: [{ name: "DepInRange", repo: dep.url, version: ">=1.0.0 <2.0.0" }],
    });

    const stderrSpy = spyOn(process.stderr, "write");
    try {
      const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkg.url, yes: true });
      expect(result.success).toBe(true);
      const warned = stderrSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("range not satisfied"),
      );
      expect(warned).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("declared version range VIOLATED → WARN naming both versions, proceed, NO silent upgrade", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "DepOutRange", version: "1.0.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: dep.url, yes: true });

    const pkg = await createMockSkillRepo(env.root, {
      name: "PkgOutRange",
      version: "1.0.0",
      dependsOnPackages: [{ name: "DepOutRange", repo: dep.url, version: ">=2.0.0" }],
    });

    const stderrSpy = spyOn(process.stderr, "write");
    try {
      const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkg.url, yes: true });

      // Warn-don't-fail (arc#284 posture): the install proceeds…
      expect(result.success).toBe(true);
      expect(getSkill(env.db, "PkgOutRange")?.status).toBe("active");
      // …the installed dependency is NOT silently upgraded…
      expect(getSkill(env.db, "DepOutRange")?.version).toBe("1.0.0");
      // …and the WARN names the declared range and the installed version.
      const warnLine = stderrSpy.mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === "string")
        .find((s) => s.includes("range not satisfied"));
      expect(warnLine).toBeDefined();
      expect(warnLine).toContain("DepOutRange@>=2.0.0");
      expect(warnLine).toContain("v1.0.0");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
