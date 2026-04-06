import { describe, test, expect, afterEach } from "bun:test";
import { install } from "../../src/commands/install.js";
import { upgradePackage, upgradeLibrary } from "../../src/commands/upgrade.js";
import { createTestEnv, createMockLibraryRepo, type TestEnv } from "../helpers/test-env.js";
import { writeFile } from "fs/promises";
import { join } from "path";

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

describe("library upgrade", () => {
  test("upgradeLibrary checks each artifact version independently", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", version: "1.0.0" },
        { path: "skills/beta", name: "beta", type: "skill", version: "1.0.0" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Bump only alpha's version in the source repo
    const alphaManifest = join(lib.path, "skills/alpha/arc-manifest.yaml");
    const content = await Bun.file(alphaManifest).text();
    await writeFile(alphaManifest, content.replace("version: 1.0.0", "version: 1.1.0"));

    Bun.spawnSync(["git", "add", "."], { cwd: lib.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump alpha"],
      { cwd: lib.path, stdout: "pipe", stderr: "pipe" }
    );

    const results = await upgradeLibrary(env.db, env.paths, "test-lib");
    expect(results).toHaveLength(2);

    const alpha = results.find((r) => r.name === "alpha")!;
    expect(alpha.success).toBe(true);
    expect(alpha.oldVersion).toBe("1.0.0");
    expect(alpha.newVersion).toBe("1.1.0");

    const beta = results.find((r) => r.name === "beta")!;
    expect(beta.success).toBe(true);
    expect(beta.oldVersion).toBe("1.0.0");
    expect(beta.newVersion).toBe("1.0.0"); // unchanged
  });

  test("upgradePackage works for single library artifact", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", version: "1.0.0" },
        { path: "skills/beta", name: "beta", type: "skill", version: "1.0.0" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Bump alpha's version
    const alphaManifest = join(lib.path, "skills/alpha/arc-manifest.yaml");
    const content = await Bun.file(alphaManifest).text();
    await writeFile(alphaManifest, content.replace("version: 1.0.0", "version: 1.1.0"));

    Bun.spawnSync(["git", "add", "."], { cwd: lib.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump alpha"],
      { cwd: lib.path, stdout: "pipe", stderr: "pipe" }
    );

    // Upgrade just alpha via upgradePackage (simulates arc upgrade library:alpha)
    const result = await upgradePackage(env.db, env.paths, "alpha");
    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.1.0");

    // Beta should remain at 1.0.0
    const beta = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("beta") as { version: string };
    expect(beta.version).toBe("1.0.0");
  });

  test("upgradeLibrary pulls repo once for all artifacts", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", version: "1.0.0" },
        { path: "skills/beta", name: "beta", type: "skill", version: "1.0.0" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Bump both versions
    for (const artifact of ["skills/alpha", "skills/beta"]) {
      const manifestPath = join(lib.path, artifact, "arc-manifest.yaml");
      const content = await Bun.file(manifestPath).text();
      await writeFile(manifestPath, content.replace("version: 1.0.0", "version: 2.0.0"));
    }

    Bun.spawnSync(["git", "add", "."], { cwd: lib.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump both"],
      { cwd: lib.path, stdout: "pipe", stderr: "pipe" }
    );

    const results = await upgradeLibrary(env.db, env.paths, "test-lib");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.every((r) => r.newVersion === "2.0.0")).toBe(true);

    // Verify DB was updated
    const alpha = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("alpha") as { version: string };
    const beta = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("beta") as { version: string };
    expect(alpha.version).toBe("2.0.0");
    expect(beta.version).toBe("2.0.0");
  });

  test("upgradeLibrary errors when no artifacts installed", async () => {
    env = await createTestEnv();
    const results = await upgradeLibrary(env.db, env.paths, "nonexistent-lib");
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("No artifacts installed");
  });

  test("upgradeLibrary reports already up to date when no version changes", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", version: "1.0.0" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // No changes in source repo
    const results = await upgradeLibrary(env.db, env.paths, "test-lib");
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].oldVersion).toBe("1.0.0");
    expect(results[0].newVersion).toBe("1.0.0");
  });

  test("upgradeLibrary discovers and installs new artifacts added to manifest", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", version: "1.0.0" },
        { path: "skills/beta", name: "beta", type: "skill", version: "1.0.0" },
      ],
    });

    // Install library with 2 artifacts
    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    // Verify only alpha and beta are installed
    const beforeSkills = env.db
      .prepare("SELECT name FROM skills WHERE library_name = ?")
      .all("test-lib") as { name: string }[];
    expect(beforeSkills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);

    // Add a 3rd artifact (gamma) to the source repo
    const gammaDir = join(lib.path, "skills/gamma");
    const gammaManifest = [
      "schema: arc/v1",
      "name: gamma",
      "version: 1.0.0",
      "type: skill",
      "author:",
      "  name: testuser",
      "  github: testuser",
      "provides:",
      "  skill:",
      "    - trigger: gamma",
      "depends_on:",
      "  tools:",
      "    - name: bun",
      '      version: ">=1.0.0"',
      "capabilities:",
      "  filesystem:",
      "    read:",
      '      - "./"',
      "    write: []",
      "  network: []",
      "  bash:",
      "    allowed: false",
      "  secrets: []",
    ].join("\n");
    await Bun.write(join(gammaDir, "arc-manifest.yaml"), gammaManifest);
    await Bun.write(
      join(gammaDir, "skill", "SKILL.md"),
      "# gamma\n\nTest skill.\n",
    );

    // Update root manifest to include gamma
    const rootManifestPath = join(lib.path, "arc-manifest.yaml");
    const rootContent = await Bun.file(rootManifestPath).text();
    const updatedRoot = rootContent.replace(
      '    description: "beta artifact"',
      '    description: "beta artifact"\n  - path: "skills/gamma"\n    description: "gamma artifact"',
    );
    await Bun.write(rootManifestPath, updatedRoot);

    // Commit changes
    Bun.spawnSync(["git", "add", "."], {
      cwd: lib.path,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "-m",
        "add gamma artifact",
      ],
      { cwd: lib.path, stdout: "pipe", stderr: "pipe" },
    );

    // Run upgrade
    const results = await upgradeLibrary(env.db, env.paths, "test-lib");

    // Should include results for alpha, beta, AND gamma
    expect(results.length).toBeGreaterThanOrEqual(3);

    const gamma = results.find((r) => r.name === "gamma");
    expect(gamma).toBeDefined();
    expect(gamma!.success).toBe(true);
    expect(gamma!.oldVersion).toBe("new");
    expect(gamma!.newVersion).toBe("1.0.0");

    // Verify gamma is in the DB
    const gammaDb = env.db
      .prepare(
        "SELECT name, version, library_name FROM skills WHERE name = ?",
      )
      .get("gamma") as {
      name: string;
      version: string;
      library_name: string;
    } | null;
    expect(gammaDb).not.toBeNull();
    expect(gammaDb!.version).toBe("1.0.0");
    expect(gammaDb!.library_name).toBe("test-lib");
  });
});
