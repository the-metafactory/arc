/**
 * Tests for arc#140 P1: ordered `lifecycle.{preinstall,postinstall}` arrays
 * are executed at install time and back-compat with `scripts.*` is preserved.
 *
 * Companion to test/commands/lifecycle-hooks.test.ts which covers the
 * pre-arc#140 single-script shape.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("install: lifecycle array execution", () => {
  test("runs lifecycle.postinstall scripts in declared order", async () => {
    const logPath = join(env.root, "lifecycle.log");
    const repo = await createMockSkillRepo(env.root, {
      name: "LifecycleOrdered",
      lifecycle: {
        postinstall: [
          { path: "scripts/01-first.sh", content: `#!/bin/bash\necho "1" >> "${logPath}"\n` },
          { path: "scripts/02-second.sh", content: `#!/bin/bash\necho "2" >> "${logPath}"\n` },
          { path: "scripts/03-third.sh", content: `#!/bin/bash\necho "3" >> "${logPath}"\n` },
        ],
      },
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(logPath)).toBe(true);
    const log = await Bun.file(logPath).text();
    expect(log).toBe("1\n2\n3\n");
  });

  test("runs lifecycle.preinstall before symlinks land", async () => {
    const markerPath = join(env.root, "preinstall-marker");
    const repo = await createMockSkillRepo(env.root, {
      name: "LifecyclePreinstall",
      lifecycle: {
        preinstall: [
          { path: "scripts/check.sh", content: `#!/bin/bash\ntouch "${markerPath}"\n` },
        ],
      },
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
  });

  test("scripts.postinstall runs BEFORE lifecycle.postinstall (both declared)", async () => {
    const logPath = join(env.root, "order.log");
    const repo = await createMockSkillRepo(env.root, {
      name: "BothShapes",
      scripts: {
        postinstall: {
          path: "scripts/legacy-postinstall.sh",
          content: `#!/bin/bash\necho "legacy" >> "${logPath}"\n`,
        },
      },
      lifecycle: {
        postinstall: [
          { path: "scripts/lifecycle-1.sh", content: `#!/bin/bash\necho "lifecycle-1" >> "${logPath}"\n` },
          { path: "scripts/lifecycle-2.sh", content: `#!/bin/bash\necho "lifecycle-2" >> "${logPath}"\n` },
        ],
      },
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
    });

    expect(result.success).toBe(true);
    const log = await Bun.file(logPath).text();
    expect(log).toBe("legacy\nlifecycle-1\nlifecycle-2\n");
  });

  test("lifecycle.postinstall failure aborts install and removes symlinks", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "LifecycleFailing",
      lifecycle: {
        postinstall: [
          { path: "scripts/ok.sh", content: `#!/bin/bash\nexit 0\n` },
          { path: "scripts/fail.sh", content: `#!/bin/bash\nexit 9\n` },
          { path: "scripts/never.sh", content: `#!/bin/bash\ntouch "${join(env.root, "should-not-exist")}"\n` },
        ],
      },
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Postinstall lifecycle script failed.*scripts\/fail\.sh/);
    expect(result.error).toMatch(/exit 9/);

    // Later script in array did NOT run
    expect(existsSync(join(env.root, "should-not-exist"))).toBe(false);

    // DB should have no record of the package
    const record = getSkill(env.db, "LifecycleFailing");
    expect(record).toBeNull();

    // Symlink should be torn down (rollback path)
    const skillLink = join(env.host.paths.skillsDir, "LifecycleFailing");
    expect(existsSync(skillLink)).toBe(false);
  });

  test("lifecycle.preinstall failure aborts before any symlinks are placed", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "PreinstallFailing",
      lifecycle: {
        preinstall: [
          { path: "scripts/fail.sh", content: `#!/bin/bash\nexit 3\n` },
        ],
        postinstall: [
          { path: "scripts/never.sh", content: `#!/bin/bash\ntouch "${join(env.root, "never-marker")}"\n` },
        ],
      },
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Preinstall lifecycle script failed.*scripts\/fail\.sh/);

    // postinstall never ran
    expect(existsSync(join(env.root, "never-marker"))).toBe(false);

    // No symlink, no DB row
    expect(getSkill(env.db, "PreinstallFailing")).toBeNull();
    expect(existsSync(join(env.host.paths.skillsDir, "PreinstallFailing"))).toBe(false);
  });

  test("PAI_HOOK env exposes the phase name to lifecycle scripts", async () => {
    const outPath = join(env.root, "hook-name.txt");
    const repo = await createMockSkillRepo(env.root, {
      name: "PaiHookEnv",
      lifecycle: {
        postinstall: [
          { path: "scripts/show.sh", content: `#!/bin/bash\necho "$PAI_HOOK" > "${outPath}"\n` },
        ],
      },
    });

    await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: repo.url, yes: true,
    });

    expect(existsSync(outPath)).toBe(true);
    const out = await Bun.file(outPath).text();
    expect(out.trim()).toBe("postinstall");
  });
});
