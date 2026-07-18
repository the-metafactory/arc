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

describe("remove — dependency removal cascade (arc#348)", () => {
  // Assert NO symlink ENTRY (dangling or otherwise) remains at `path`. lstat
  // succeeds on a dangling symlink, so a plain existsSync (which follows the
  // link) would pass even when an orphaned symlink is left behind — this checks
  // the directory entry itself is gone.
  async function expectNoSymlinkEntry(path: string): Promise<void> {
    let threw = false;
    try {
      await lstat(path);
    } catch (err) {
      threw = true;
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    expect(threw).toBe(true);
  }

  test("removing a component removes its exclusively-owned depends_on.packages", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "adapter-excl", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "comp-excl",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-excl", repo: dep.url }],
    });
    // Installing the parent installs the declared dependency too (arc#306).
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });
    expect(getSkill(env.db, "adapter-excl")?.status).toBe("active");

    const result = await remove(env.db, env.arc, env.host, "comp-excl", { yes: true });

    expect(result.success).toBe(true);
    // The exclusively-owned adapter cascaded out with the parent.
    expect(result.cascaded?.length).toBe(1);
    expect(result.cascaded?.[0]).toMatchObject({ name: "adapter-excl", success: true });
    expect(getSkill(env.db, "comp-excl")).toBeNull();
    expect(getSkill(env.db, "adapter-excl")).toBeNull();
    // Repo clone for the dep is gone too.
    expect(existsSync(join(env.arc.reposDir, "mock-adapter-excl"))).toBe(false);
  });

  test("a dependency still required by another installed package is RETAINED (refcount)", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "adapter-shared", version: "1.0.0" });
    const parentA = await createMockSkillRepo(env.root, {
      name: "comp-a",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-shared", repo: dep.url }],
    });
    const parentB = await createMockSkillRepo(env.root, {
      name: "comp-b",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-shared", repo: dep.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parentA.url, yes: true });
    // Installing B reuses the already-installed shared adapter (arc#306 skip).
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parentB.url, yes: true });
    expect(getSkill(env.db, "adapter-shared")?.status).toBe("active");

    const result = await remove(env.db, env.arc, env.host, "comp-a", { yes: true });

    expect(result.success).toBe(true);
    // The shared adapter was NOT removed — comp-b still requires it.
    expect(result.cascaded).toBeUndefined();
    expect(result.retained?.length).toBe(1);
    expect(result.retained?.[0]).toEqual({ name: "adapter-shared", requiredBy: ["comp-b"] });
    // Still installed + active + on disk.
    expect(getSkill(env.db, "adapter-shared")?.status).toBe("active");
    expect(existsSync(join(env.host.paths.skillsDir, "adapter-shared"))).toBe(true);
    expect(existsSync(join(env.arc.reposDir, "mock-adapter-shared"))).toBe(true);
  });

  test("a failed dependency removal is reported but does NOT abort the parent", async () => {
    // The dep declares a preuninstall lifecycle script that exits non-zero →
    // its own remove() ABORTS (D7), surfacing success:false under `cascaded`
    // without undoing the already-committed parent removal.
    const dep = await createMockSkillRepo(env.root, {
      name: "adapter-brk",
      version: "1.0.0",
      lifecycle: {
        preuninstall: [{ path: "scripts/fail.sh", content: "#!/bin/sh\nexit 1\n" }],
      },
    });
    const parent = await createMockSkillRepo(env.root, {
      name: "comp-brk",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-brk", repo: dep.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });
    expect(getSkill(env.db, "adapter-brk")?.status).toBe("active");

    const result = await remove(env.db, env.arc, env.host, "comp-brk", { yes: true });

    expect(result.success).toBe(true); // parent still succeeds
    expect(getSkill(env.db, "comp-brk")).toBeNull();
    expect(result.cascaded?.length).toBe(1);
    expect(result.cascaded?.[0].success).toBe(false); // dep failure surfaced, not swallowed
    expect(result.cascaded?.[0].name).toBe("adapter-brk");
    // The dep's preuninstall aborted its teardown → it is still installed.
    expect(getSkill(env.db, "adapter-brk")?.status).toBe("active");
  });

  test("no orphaned symlinks remain after a cascade removal", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "adapter-orph", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "comp-orph",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-orph", repo: dep.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });

    // Both symlinks exist before removal.
    const parentLink = join(env.host.paths.skillsDir, "comp-orph");
    const depLink = join(env.host.paths.skillsDir, "adapter-orph");
    expect(existsSync(parentLink)).toBe(true);
    expect(existsSync(depLink)).toBe(true);

    await remove(env.db, env.arc, env.host, "comp-orph", { yes: true });

    // Neither the parent nor the cascaded dep leaves a symlink entry behind.
    await expectNoSymlinkEntry(parentLink);
    await expectNoSymlinkEntry(depLink);
  });

  test("--keep-deps (keepDeps) leaves depends_on.packages installed", async () => {
    const dep = await createMockSkillRepo(env.root, { name: "adapter-keep", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "comp-keep",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-keep", repo: dep.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });

    const result = await remove(env.db, env.arc, env.host, "comp-keep", { yes: true, keepDeps: true });

    expect(result.success).toBe(true);
    expect(result.cascaded).toBeUndefined();
    expect(result.retained).toBeUndefined();
    // Dep left in place.
    expect(getSkill(env.db, "adapter-keep")?.status).toBe("active");
    expect(existsSync(join(env.host.paths.skillsDir, "adapter-keep"))).toBe(true);
  });
});
