import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import {
  checkUpgrades,
  upgradePackage,
  upgradeAll,
  upgradeLibrary,
  formatCheckResults,
  formatUpgradeResults,
} from "../../src/commands/upgrade.js";
import { loadSources, saveSources } from "../../src/lib/sources.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import type { RegistryConfig, SourcesConfig } from "../../src/types.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("checkUpgrades", () => {
  test("detects when registry version is newer than installed", async () => {
    // Install a skill at v1.0.0
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Set up a source with registry advertising v1.1.0
    const registry: RegistryConfig = {
      registry: {
        skills: [
          {
            name: "TestSkill",
            description: "A test skill",
            author: "tester",
            version: "1.1.0",
            source: repo.url,
            type: "community",
            status: "shipped",
          },
        ],
        agents: [],
        prompts: [],
        tools: [],
      },
    };

    // Write as a file:// source
    const regPath = join(env.root, "test-registry.yaml");
    await writeFile(regPath, YAML.stringify(registry));

    const sources: SourcesConfig = {
      sources: [
        { name: "test", url: `file://${regPath}`, tier: "community", enabled: true },
      ],
    };
    await saveSources(env.arc.sourcesPath, sources);

    const results = await checkUpgrades(env.db, env.arc, env.host);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("TestSkill");
    expect(results[0].installedVersion).toBe("1.0.0");
    expect(results[0].registryVersion).toBe("1.1.0");
    expect(results[0].upgradable).toBe(true);
  });

  // arc#184 Bug 2: installed-name is the bare slug ("soma") but the registry
  // entry uses the scoped form ("@metafactory/soma"). checkUpgrades was looking
  // up by skill.name (bare) against findRegistryEntry which only did an exact
  // case-insensitive match, so registryVersion stayed null and upgradable was
  // false — even when the registry advertised a newer version.
  test("resolves scoped registry entry from bare installed-name (arc#184)", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "scoped-bug",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Registry advertises the same package under a SCOPED name. The installed
    // copy is recorded by its bare slug in the DB (because that's what the
    // manifest says). checkUpgrades must reconcile the two.
    const registry: RegistryConfig = {
      registry: {
        skills: [
          {
            name: "@metafactory/scoped-bug",
            description: "A scoped package",
            author: "tester",
            version: "1.1.0",
            source: repo.url,
            type: "community",
            status: "shipped",
          },
        ],
        agents: [],
        prompts: [],
        tools: [],
      },
    };

    const regPath = join(env.root, "scoped-registry.yaml");
    await writeFile(regPath, YAML.stringify(registry));
    await saveSources(env.arc.sourcesPath, {
      sources: [{ name: "test", url: `file://${regPath}`, tier: "community", enabled: true }],
    });

    const results = await checkUpgrades(env.db, env.arc, env.host);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("scoped-bug");
    expect(results[0].installedVersion).toBe("1.0.0");
    expect(results[0].registryVersion).toBe("1.1.0");
    expect(results[0].upgradable).toBe(true);
  });

  test("reports up-to-date when versions match", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "UpToDate",
      version: "2.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const registry: RegistryConfig = {
      registry: {
        skills: [
          {
            name: "UpToDate",
            description: "A current skill",
            author: "tester",
            version: "2.0.0",
            source: repo.url,
            type: "community",
            status: "shipped",
          },
        ],
        agents: [],
        prompts: [],
        tools: [],
      },
    };

    const regPath = join(env.root, "test-registry.yaml");
    await writeFile(regPath, YAML.stringify(registry));
    await saveSources(env.arc.sourcesPath, {
      sources: [{ name: "test", url: `file://${regPath}`, tier: "community", enabled: true }],
    });

    const results = await checkUpgrades(env.db, env.arc, env.host);
    expect(results[0].upgradable).toBe(false);
  });
});

describe("upgradePackage", () => {
  test("pulls latest and updates DB version", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Upgradeable",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Simulate a new version: update manifest in source repo and commit
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, content.replace("version: 1.0.0", "version: 1.1.0"));

    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump version"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" }
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "Upgradeable");
    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.1.0");

    // Verify DB was updated
    const skill = env.db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("Upgradeable") as { version: string };
    expect(skill.version).toBe("1.1.0");
  });

  test("reports already up to date when no new commits", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Current",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await upgradePackage(env.db, env.arc, env.host, "Current");
    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.0.0");
  });

  // arc#184 Bug 1: when the install path is a tarball-extract (no `.git`
  // directory anywhere up the tree), upgradePackage's git pull blows up with
  // "git pull failed: fatal: not a git repository". The right behavior is to
  // recognise the tarball-extract install and surface a clear, actionable
  // error (or, ideally, take the tarball-re-extract path). Until the
  // tarball-re-extract path lands, the test asserts at minimum that the
  // failure message tells the user what to do instead of being cryptic.
  test("returns actionable error for tarball-extract installs (no .git) (arc#184)", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TarballExtract",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Simulate the tarball-extract install layout: the install dir exists
    // and has a valid manifest but no `.git` directory anywhere up the tree.
    // This matches what `arc install @scope/name` produces today via
    // downloadPackage + extractPackage.
    //
    // Relies on the test env's reposDir (under the OS temp dir) not being
    // nested inside a git repo — findGitRoot walks up 10 parents, so a
    // tmpdir under a git tree would defeat the no-.git simulation. True for
    // the standard macOS/Linux $TMPDIR; revisit if CI changes the temp root.
    const { getSkill } = await import("../../src/lib/db.js");
    const skillRow = getSkill(env.db, "TarballExtract");
    expect(skillRow).not.toBeNull();
    Bun.spawnSync(["rm", "-rf", join(skillRow!.install_path, ".git")], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const result = await upgradePackage(env.db, env.arc, env.host, "TarballExtract");
    expect(result.success).toBe(false);
    // The error message must NOT be the raw git output — that's the bug.
    expect(result.error).not.toContain("not a git repository");
    // It MUST mention either the tarball/registry-install nature or the
    // remove-then-install workaround so the user knows what to do.
    expect(result.error).toMatch(/registry|tarball|remove.*install/i);
  });

  test("returns error for unknown package", async () => {
    const result = await upgradePackage(env.db, env.arc, env.host, "NotInstalled");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });

  test("with force flag, re-runs upgrade pipeline and updates DB", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "ForceUpgrade",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Without force: returns success with same version (short-circuit)
    const normalResult = await upgradePackage(env.db, env.arc, env.host, "ForceUpgrade");
    expect(normalResult.success).toBe(true);
    expect(normalResult.oldVersion).toBe("1.0.0");
    expect(normalResult.newVersion).toBe("1.0.0");

    // Manually set DB version to something old to prove the pipeline restores it
    env.db.prepare("UPDATE skills SET version = ? WHERE name = ?").run("0.9.0", "ForceUpgrade");

    // Verify DB was actually changed
    const before = env.db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("ForceUpgrade") as { version: string };
    expect(before.version).toBe("0.9.0");

    // With force: runs the full upgrade pipeline, updates DB back to manifest version
    const forceResult = await upgradePackage(env.db, env.arc, env.host, "ForceUpgrade", { force: true });
    expect(forceResult.success).toBe(true);
    expect(forceResult.oldVersion).toBe("0.9.0");
    expect(forceResult.newVersion).toBe("1.0.0");

    // Verify DB version was restored by the pipeline
    const after = env.db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("ForceUpgrade") as { version: string };
    expect(after.version).toBe("1.0.0");
  });
});

describe("formatCheckResults", () => {
  test("formats upgradable packages", () => {
    const output = formatCheckResults([
      {
        name: "Foo",
        installedVersion: "1.0.0",
        registryVersion: "1.1.0",
        repoVersion: null,
        upgradable: true,
      },
      {
        name: "Bar",
        installedVersion: "2.0.0",
        registryVersion: "2.0.0",
        repoVersion: null,
        upgradable: false,
      },
    ]);
    expect(output).toContain("1 package(s)");
    expect(output).toContain("Foo");
    expect(output).toContain("1.0.0 → 1.1.0");
    expect(output).not.toContain("Bar");
  });

  test("shows all up to date message", () => {
    const output = formatCheckResults([
      {
        name: "Current",
        installedVersion: "1.0.0",
        registryVersion: "1.0.0",
        repoVersion: null,
        upgradable: false,
      },
    ]);
    expect(output).toContain("up to date");
  });
});

describe("formatUpgradeResults", () => {
  test("formats successful upgrade", () => {
    const output = formatUpgradeResults([
      { success: true, name: "Foo", oldVersion: "1.0.0", newVersion: "1.1.0" },
    ]);
    expect(output).toContain("Foo");
    expect(output).toContain("1.0.0 → 1.1.0");
  });

  test("formats failed upgrade", () => {
    const output = formatUpgradeResults([
      { success: false, name: "Bar", oldVersion: "1.0.0", error: "git pull failed" },
    ]);
    expect(output).toContain("Bar");
    expect(output).toContain("failed");
  });

  test("returns nothing message for empty", () => {
    expect(formatUpgradeResults([])).toContain("Nothing to upgrade");
  });
});

describe("upgradeAll", () => {
  test("with force upgrades packages already at latest", async () => {
    // Install a package at v1.0.0 (no registry advertising a newer version)
    const repo = await createMockSkillRepo(env.root, {
      name: "ForceAll",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Without force, upgradeAll would return empty (nothing upgradable)
    const normalResults = await upgradeAll(env.db, env.arc, env.host);
    expect(normalResults).toHaveLength(0);

    // With force, upgradeAll should include all active packages
    const forceResults = await upgradeAll(env.db, env.arc, env.host, { force: true });
    expect(forceResults).toHaveLength(1);
    expect(forceResults[0].name).toBe("ForceAll");
    expect(forceResults[0].success).toBe(true);
  });
});

describe("upgradeLibrary", () => {
  test("with force re-runs upgrade for library artifacts", async () => {
    // Install a regular package and set its library_name in the DB
    const repo = await createMockSkillRepo(env.root, {
      name: "LibArtifact",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Set a library_name so upgradeLibrary can find it
    env.db.prepare("UPDATE skills SET library_name = ? WHERE name = ?").run("my-lib", "LibArtifact");

    // upgradeLibrary with force should process the artifact without error
    const results = await upgradeLibrary(env.db, env.arc, env.host, "my-lib", { force: true });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("LibArtifact");
    expect(results[0].success).toBe(true);
  });

  test("returns error for unknown library", async () => {
    const results = await upgradeLibrary(env.db, env.arc, env.host, "nonexistent-lib");
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("No artifacts installed");
  });
});
