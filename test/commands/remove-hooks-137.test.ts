/**
 * Regression test for arc#137 — `arc remove` must clean hook entries
 * from settings.json even when the manifest is unreadable (source repo
 * deleted out-of-band).
 *
 * Before the fix:
 *   remove.ts gated `removeHooks()` on
 *   `hasHooks(manifest?.provides?.hooks)`. A null manifest short-circuited
 *   the call, leaving orphan hook entries that surfaced as "No such file
 *   or directory" errors in Claude Code on every session start.
 *
 * After the fix:
 *   `removeHooks()` is always called with the package name. The filter
 *   inside keys on the `_pai_pkg` tag written at install time, so a
 *   missing manifest no longer matters.
 *
 * Test strategy: seed `settings.json` directly with a hook entry tagged
 * `_pai_pkg: <name>` and record a matching skill row. Skips the full
 * install pipeline — the regression is in remove(), not install().
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { remove } from "../../src/commands/remove.js";
import { disable } from "../../src/commands/disable.js";
import { recordInstall } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

async function readSettings(): Promise<{ hooks?: Record<string, unknown[]> }> {
  return JSON.parse(await Bun.file(env.host.paths.settingsPath).text());
}

/**
 * Seed settings.json with one hook entry tagged for `packageName`, plus
 * one for an unrelated package. Returns when both entries are persisted.
 */
async function seedSettingsWithHook(packageName: string): Promise<void> {
  await Bun.write(
    env.host.paths.settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: `/tmp/${packageName}-hook.ts` },
            ],
            _pai_pkg: packageName,
          },
          {
            hooks: [
              { type: "command", command: "/tmp/other-hook.ts" },
            ],
            _pai_pkg: "OtherPackage",
          },
        ],
      },
    }),
  );
}

/**
 * Stand a skill row up in the DB plus an installed-clone directory.
 * Skips the full install() pipeline — what we're testing is what
 * `remove()` does given an extant DB row.
 */
async function seedInstalledSkill(name: string): Promise<string> {
  const repo = await createMockSkillRepo(env.root, { name });
  const installPath = join(env.arc.reposDir, `mock-${name}`);
  // Copy mock repo files into reposDir where install() would have cloned them
  await Bun.write(
    join(installPath, "arc-manifest.yaml"),
    await Bun.file(join(repo.path, "arc-manifest.yaml")).text(),
  );
  await Bun.write(
    join(installPath, "skill", "SKILL.md"),
    await Bun.file(join(repo.path, "skill", "SKILL.md")).text(),
  );
  const now = new Date().toISOString();
  recordInstall(env.db, {
    name,
    version: "1.0.0",
    repo_url: repo.url,
    install_path: installPath,
    skill_dir: join(installPath, "skill"),
    status: "active",
    artifact_type: "skill",
    tier: "custom",
    customization_path: null,
    install_source: null,
    library_name: null,
    installed_at: now,
    updated_at: now,
  }, {
    name,
    version: "1.0.0",
    type: "skill",
    capabilities: {
      filesystem: { read: [], write: [] },
      network: [],
      bash: { allowed: false },
      secrets: [],
    },
  });
  return installPath;
}

describe("arc#137 — remove cleans hooks even when manifest is unreadable", () => {
  test("baseline: remove cleans hook entry when manifest is readable", async () => {
    const name = "AlphaSkill";
    await seedInstalledSkill(name);
    await seedSettingsWithHook(name);

    // Sanity: entry present before remove
    const before = await readSettings();
    const beforeEntries = (before.hooks?.SessionStart ?? []) as Array<{ _pai_pkg?: string }>;
    expect(beforeEntries.some((h) => h._pai_pkg === name)).toBe(true);

    const result = await remove(env.db, env.arc, env.host, name, { yes: true });
    expect(result.success).toBe(true);

    const after = await readSettings();
    const afterEntries = (after.hooks?.SessionStart ?? []) as Array<{ _pai_pkg?: string }>;
    expect(afterEntries.some((h) => h._pai_pkg === name)).toBe(false);
    // Unrelated package untouched
    expect(afterEntries.some((h) => h._pai_pkg === "OtherPackage")).toBe(true);
  });

  test("regression: remove cleans hook entry when source repo deleted out-of-band (arc#137)", async () => {
    const name = "BetaSkill";
    const installPath = await seedInstalledSkill(name);
    await seedSettingsWithHook(name);

    // Simulate the arc#137 reproduction: source repo deleted out-of-band
    // (e.g. grove → cortex migration). The installed clone disappears;
    // manifest reads return null.
    await rm(installPath, { recursive: true, force: true });

    const result = await remove(env.db, env.arc, env.host, name, { yes: true });
    expect(result.success).toBe(true);

    // Pre-fix this would still contain the BetaSkill entry — null manifest
    // short-circuited the removeHooks call.
    const after = await readSettings();
    const afterEntries = (after.hooks?.SessionStart ?? []) as Array<{ _pai_pkg?: string }>;
    expect(afterEntries.some((h) => h._pai_pkg === name)).toBe(false);
    expect(afterEntries.some((h) => h._pai_pkg === "OtherPackage")).toBe(true);
  });

  test("disable also cleans hook entry when manifest is unreadable (parity with remove)", async () => {
    // Same bug existed in disable.ts — sage P147 review observation that
    // `hasHooks` had multiple callsites surfaced this adjacent path.
    const name = "DeltaSkill";
    const installPath = await seedInstalledSkill(name);
    await seedSettingsWithHook(name);

    await rm(installPath, { recursive: true, force: true });

    const result = await disable(env.db, env.arc, env.host, name);
    expect(result.success).toBe(true);

    const after = await readSettings();
    const afterEntries = (after.hooks?.SessionStart ?? []) as Array<{ _pai_pkg?: string }>;
    expect(afterEntries.some((h) => h._pai_pkg === name)).toBe(false);
    expect(afterEntries.some((h) => h._pai_pkg === "OtherPackage")).toBe(true);
  });

  test("remove of a hookless package is a settings.json no-op (touches only own entries)", async () => {
    const name = "GammaSkill";
    await seedInstalledSkill(name);
    // Seed settings.json with ONLY unrelated entries
    await Bun.write(
      env.host.paths.settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "/tmp/x-hook.ts" }],
              _pai_pkg: "OtherPackage",
            },
          ],
        },
      }),
    );

    const result = await remove(env.db, env.arc, env.host, name, { yes: true });
    expect(result.success).toBe(true);

    const after = await readSettings();
    const afterEntries = (after.hooks?.SessionStart ?? []) as Array<{ _pai_pkg?: string }>;
    expect(afterEntries.length).toBe(1);
    expect(afterEntries[0]._pai_pkg).toBe("OtherPackage");
  });

});
