import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { writeFile } from "fs/promises";
import {
  createTestEnv,
  createMockLibraryRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { list } from "../../src/commands/list.js";
import { remove } from "../../src/commands/remove.js";
import { upgradeLibrary } from "../../src/commands/upgrade.js";
import { listByLibrary } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("Library lifecycle: install → list → upgrade → remove", () => {
  test("full lifecycle with 2 artifacts", async () => {
    // --- INSTALL ---
    const lib = await createMockLibraryRepo(env.root, {
      name: "my-lib",
      artifacts: [
        { path: "skills/review", name: "review", type: "skill", version: "1.0.0" },
        { path: "skills/deploy", name: "deploy", type: "skill", version: "1.0.0" },
      ],
    });

    const installResult = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: lib.url,
      yes: true,
    });

    expect(installResult.success).toBe(true);
    expect(installResult.artifacts).toHaveLength(2);

    // Verify symlinks exist
    expect(existsSync(join(env.paths.skillsDir, "review"))).toBe(true);
    expect(existsSync(join(env.paths.skillsDir, "deploy"))).toBe(true);

    // --- LIST ---
    const allList = list(env.db);
    expect(allList.skills).toHaveLength(2);
    expect(allList.skills.every((s) => s.library_name === "my-lib")).toBe(true);

    // List filtered by library
    const libList = list(env.db, { library: "my-lib" });
    expect(libList.skills).toHaveLength(2);

    // --- UPGRADE ---
    // Bump review to 1.1.0 in source repo
    const reviewManifest = join(lib.path, "skills/review/arc-manifest.yaml");
    const content = await Bun.file(reviewManifest).text();
    await writeFile(reviewManifest, content.replace("version: 1.0.0", "version: 1.1.0"));

    Bun.spawnSync(["git", "add", "."], { cwd: lib.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump review"],
      { cwd: lib.path, stdout: "pipe", stderr: "pipe" }
    );

    const upgradeResults = await upgradeLibrary(env.db, env.paths, "my-lib");
    expect(upgradeResults).toHaveLength(2);

    const reviewUpgrade = upgradeResults.find((r) => r.name === "review")!;
    expect(reviewUpgrade.success).toBe(true);
    expect(reviewUpgrade.newVersion).toBe("1.1.0");

    const deployUpgrade = upgradeResults.find((r) => r.name === "deploy")!;
    expect(deployUpgrade.success).toBe(true);
    expect(deployUpgrade.newVersion).toBe("1.0.0"); // unchanged

    // Verify DB version updated
    const reviewDb = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("review") as { version: string };
    expect(reviewDb.version).toBe("1.1.0");

    // --- REMOVE ONE ---
    const removeResult = await remove(env.db, env.paths, "review");
    expect(removeResult.success).toBe(true);

    // Verify review is gone but deploy remains
    const remaining = list(env.db);
    expect(remaining.skills).toHaveLength(1);
    expect(remaining.skills[0].name).toBe("deploy");
    expect(remaining.skills[0].library_name).toBe("my-lib");

    // Symlink removed for review
    expect(existsSync(join(env.paths.skillsDir, "review"))).toBe(false);
    // Symlink still exists for deploy
    expect(existsSync(join(env.paths.skillsDir, "deploy"))).toBe(true);

    // Library artifacts query returns only deploy
    const libArtifacts = listByLibrary(env.db, "my-lib");
    expect(libArtifacts).toHaveLength(1);
    expect(libArtifacts[0].name).toBe("deploy");

    // --- REMOVE LAST ---
    const removeLastResult = await remove(env.db, env.paths, "deploy");
    expect(removeLastResult.success).toBe(true);

    // Everything gone
    const finalList = list(env.db);
    expect(finalList.skills).toHaveLength(0);
    expect(listByLibrary(env.db, "my-lib")).toHaveLength(0);
  });
});
