import { describe, test, expect, afterEach } from "bun:test";
import { unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { install } from "../../src/commands/install.js";
import { list } from "../../src/commands/list.js";
import {
  createTestEnv,
  createMockLibraryRepo,
  type TestEnv,
} from "../helpers/test-env.js";

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/**
 * arc#248: `arc install <library>` reported "Installed N artifact(s)" while
 * dropping NOTHING to the host, when members already had an `active` DB row
 * from a prior run whose drop never landed (or whose host dir was later wiped).
 * The skip-guard trusted the DB and never checked the filesystem.
 *
 * The fix gates the active-skip on artifactDropPresent: a member is skipped
 * ONLY when its host-side drop is actually present on disk; otherwise install
 * re-drops it.
 */
describe("install library — skip-if-active verifies the host drop (arc#248)", () => {
  test("re-drops a member whose DB row is active but whose host drop is absent", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "drop-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    // First install — both members land (DB rows + host symlinks).
    const first = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });
    expect(first.success).toBe(true);

    const alphaLink = join(env.host.paths.skillsDir, "alpha");
    const betaLink = join(env.host.paths.skillsDir, "beta");
    expect(existsSync(alphaLink)).toBe(true);
    expect(existsSync(betaLink)).toBe(true);

    // Simulate the arc#248 divergence: the DB still says alpha is `active`, but
    // its host drop is gone (e.g. a scratch host dir wiped under the bot).
    await unlink(alphaLink);
    expect(existsSync(alphaLink)).toBe(false);
    // DB row is untouched — still active.
    expect(list(env.db).skills.find((s) => s.name === "alpha")?.status).toBe("active");

    // Reinstall. Pre-fix this was a silent no-op (alpha skipped, link stays
    // gone). Post-fix the missing drop is detected and alpha is re-dropped.
    const second = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });
    expect(second.success).toBe(true);

    // The core assertion: alpha's host drop is back.
    expect(existsSync(alphaLink)).toBe(true);
    // No duplicate DB rows.
    expect(list(env.db).skills).toHaveLength(2);
  });

  test("still skips a member whose DB row is active AND whose drop is present", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "skip-lib",
      artifacts: [
        { path: "skills/gamma", name: "gamma", type: "skill" },
        { path: "skills/delta", name: "delta", type: "skill" },
      ],
    });

    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true });

    const gammaLink = join(env.host.paths.skillsDir, "gamma");
    expect(existsSync(gammaLink)).toBe(true);

    // Capture the symlink's lstat mtime/ino so we can confirm the second
    // install does NOT recreate it (skip path taken, no needless re-drop).
    const { lstat } = await import("fs/promises");
    const before = await lstat(gammaLink);

    const second = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true });
    expect(second.success).toBe(true);
    // Both members report success (skip counts as success).
    expect(second.artifacts!.every((a) => a.success)).toBe(true);

    const after = await lstat(gammaLink);
    // Same inode → the symlink was NOT recreated; the skip path was taken.
    expect(after.ino).toBe(before.ino);

    expect(list(env.db).skills).toHaveLength(2);
  });
});
