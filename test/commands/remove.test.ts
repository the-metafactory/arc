import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { lstat, readlink, unlink, writeFile } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  createMockLibraryRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove, removeLibrary } from "../../src/commands/remove.js";
import { getSkill, listByLibrary } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("remove command", () => {
  test("deletes repo directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const repoDir = join(env.arc.reposDir, "mock-TestSkill");
    expect(existsSync(repoDir)).toBe(true);

    await remove(env.db, env.arc, env.host, "TestSkill");
    expect(existsSync(repoDir)).toBe(false);
  });

  test("deletes packages.db entry", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    await remove(env.db, env.arc, env.host, "TestSkill");
    expect(getSkill(env.db, "TestSkill")).toBeNull();
  });

  test("removes skill symlink", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    await remove(env.db, env.arc, env.host, "TestSkill");

    const skillLink = join(env.host.paths.skillsDir, "TestSkill");
    expect(existsSync(skillLink)).toBe(false);
  });

  test("rejects removing non-installed skill", async () => {
    const result = await remove(env.db, env.arc, env.host, "NonExistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });
});

describe("removeLibrary", () => {
  test("removes all artifacts when given library name", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    // Both artifacts should be installed
    expect(getSkill(env.db, "alpha")).not.toBeNull();
    expect(getSkill(env.db, "beta")).not.toBeNull();

    const result = await removeLibrary(env.db, env.arc, env.host, "test-lib");
    expect(result.success).toBe(true);
    expect(result.removedCount).toBe(2);
    expect(getSkill(env.db, "alpha")).toBeNull();
    expect(getSkill(env.db, "beta")).toBeNull();
  });

  test("cleans up repo directory after removing all library artifacts", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    // Find the repo directory from the first artifact's install_path
    const alphaSkill = getSkill(env.db, "alpha")!;
    const repoDir = join(alphaSkill.install_path, "..", "..");

    expect(existsSync(repoDir)).toBe(true);

    await removeLibrary(env.db, env.arc, env.host, "test-lib");
    expect(existsSync(repoDir)).toBe(false);
  });

  test("individual artifact removal preserves other library artifacts", async () => {
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    // Remove only alpha
    const result = await remove(env.db, env.arc, env.host, "alpha");
    expect(result.success).toBe(true);

    // Beta should still exist
    expect(getSkill(env.db, "beta")).not.toBeNull();
    // Library still has one artifact
    expect(listByLibrary(env.db, "test-lib")).toHaveLength(1);
  });

  test("returns error for unknown name (not artifact, not library)", async () => {
    const result = await removeLibrary(env.db, env.arc, env.host, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });
});

describe("remove parity with install (arc#138)", () => {
  test("accepts -y / yes option", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "YesFlag",
    });
    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Smoke: opts.yes is accepted without throwing, mirrors install.
    const result = await remove(env.db, env.arc, env.host, "YesFlag", { yes: true });
    expect(result.success).toBe(true);
    expect(getSkill(env.db, "YesFlag")).toBeNull();
  });

  test("reverse-iterates provides.files and removes installed symlinks", async () => {
    const fileTargetA = join(env.root, "fake-home", "plistA");
    const fileTargetB = join(env.root, "fake-home", "plistB");
    const repo = await createMockSkillRepo(env.root, {
      name: "FilesPkg",
      files: [
        { source: "files/plist-a", target: fileTargetA, content: "PLIST A\n" },
        { source: "files/plist-b", target: fileTargetB, content: "PLIST B\n" },
      ],
    });

    const installed = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });
    expect(installed.success).toBe(true);

    // Both targets must be valid symlinks before remove.
    expect((await lstat(fileTargetA)).isSymbolicLink()).toBe(true);
    expect((await lstat(fileTargetB)).isSymbolicLink()).toBe(true);

    const result = await remove(env.db, env.arc, env.host, "FilesPkg", { yes: true });
    expect(result.success).toBe(true);

    expect(existsSync(fileTargetA)).toBe(false);
    expect(existsSync(fileTargetB)).toBe(false);
  });

  test("leaves hand-edited files untouched (symlink replaced by regular file)", async () => {
    const fileTarget = join(env.root, "fake-home", "kept");
    const repo = await createMockSkillRepo(env.root, {
      name: "HandEdited",
      files: [{ source: "files/orig", target: fileTarget, content: "from-pkg\n" }],
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Operator replaces the arc-installed symlink with their own regular file.
    await unlink(fileTarget);
    await writeFile(fileTarget, "operator-customised\n", "utf8");

    const result = await remove(env.db, env.arc, env.host, "HandEdited", { yes: true });
    expect(result.success).toBe(true);

    // Regular file MUST survive — arc has no business deleting user content.
    expect(existsSync(fileTarget)).toBe(true);
    expect((await lstat(fileTarget)).isSymbolicLink()).toBe(false);
  });

  test("leaves symlinks pointing somewhere else untouched", async () => {
    const fileTarget = join(env.root, "fake-home", "redirected");
    const elsewhere = join(env.root, "elsewhere.txt");
    await writeFile(elsewhere, "from-elsewhere\n", "utf8");

    const repo = await createMockSkillRepo(env.root, {
      name: "Redirected",
      files: [{ source: "files/x", target: fileTarget, content: "from-pkg\n" }],
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Operator re-points the symlink to a file outside the package.
    await unlink(fileTarget);
    const { symlink } = await import("fs/promises");
    await symlink(elsewhere, fileTarget);

    const result = await remove(env.db, env.arc, env.host, "Redirected", { yes: true });
    expect(result.success).toBe(true);

    // Symlink (and the file it points at) MUST survive.
    expect((await lstat(fileTarget)).isSymbolicLink()).toBe(true);
    expect(await readlink(fileTarget)).toBe(elsewhere);
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("fires scripts.preremove before tearing down the package", async () => {
    const markerPath = join(env.root, "preremove-ran");
    const fileTarget = join(env.root, "fake-home", "tracked");
    const repo = await createMockSkillRepo(env.root, {
      name: "PreRemoveSkill",
      files: [{ source: "files/tracked", target: fileTarget, content: "tracked\n" }],
      scripts: {
        preremove: {
          path: "./scripts/preremove.sh",
          // Capture whether the symlink still exists at preremove time.
          // If preremove fires AFTER teardown the file would already be gone.
          content: `#!/bin/bash\nif [ -L "${fileTarget}" ]; then echo "preremove-pre-teardown" > "${markerPath}"; else echo "preremove-post-teardown" > "${markerPath}"; fi\n`,
        },
      },
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = await remove(env.db, env.arc, env.host, "PreRemoveSkill", { yes: true });
    expect(result.success).toBe(true);

    expect(existsSync(markerPath)).toBe(true);
    const content = await Bun.file(markerPath).text();
    expect(content.trim()).toBe("preremove-pre-teardown");

    // And the file the marker referenced is gone after the remove completes.
    expect(existsSync(fileTarget)).toBe(false);
  });

  test("no preremove script in manifest → remove is still a no-op for that hook", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "NoPreRemove",
    });
    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Should succeed without trying to run any preremove script.
    const result = await remove(env.db, env.arc, env.host, "NoPreRemove", { yes: true });
    expect(result.success).toBe(true);
    expect(getSkill(env.db, "NoPreRemove")).toBeNull();
  });
});
