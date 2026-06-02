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
import { saveSources } from "../../src/lib/sources.js";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
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

// ---------------------------------------------------------------------------
// arc#187 — registry-extracted package upgrade path
// ---------------------------------------------------------------------------

function mockFetch(handler: (input: any, init?: any) => Promise<Response>): typeof fetch {
  const fn = handler as typeof fetch;
  (fn as any).preconnect = () => {};
  return fn;
}

/**
 * Build a real gzipped package tarball (single top-level dir containing
 * arc-manifest.yaml) and return its bytes + sha256 so a mocked metafactory
 * registry can advertise and serve it. extractPackage strips one path
 * component, so the manifest must live one level deep.
 */
async function buildRegistryFixture(
  baseDir: string,
  name: string,
  version: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const stageRoot = join(baseDir, `__fixture-${name}-${version}`);
  const topDir = join(stageRoot, "pkg");
  await mkdir(join(topDir, "skill"), { recursive: true });
  await writeFile(join(topDir, "skill", "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
  await writeFile(
    join(topDir, "arc-manifest.yaml"),
    YAML.stringify({
      name,
      version,
      type: "skill",
      tier: "custom",
      author: { name: "t", github: "t" },
      provides: { skill: [{ trigger: name.toLowerCase() }] },
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    }),
  );
  const tarPath = join(baseDir, `__fixture-${name}-${version}.tar.gz`);
  Bun.spawnSync(["tar", "czf", tarPath, "-C", stageRoot, "pkg"], { stdout: "pipe", stderr: "pipe" });
  const buf = await Bun.file(tarPath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buf);
  return { bytes: new Uint8Array(buf), sha256: hasher.digest("hex") };
}

function metafactoryRegistryHandler(opts: {
  scope: string;
  name: string;
  latestVersion: string;
  sha256: string;
  tarball?: Uint8Array;
}) {
  return async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/storage/download/")) {
      return new Response((opts.tarball ?? new Uint8Array()) as unknown as BodyInit, { status: 200 });
    }
    // version detail: /packages/<scope>/<name>@<version>
    if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
      return new Response(JSON.stringify({
        version: opts.latestVersion,
        sha256: opts.sha256,
        manifest_canonical: `{"name":"@${opts.scope}/${opts.name}","version":"${opts.latestVersion}"}`,
        signing: { registry_signature: null, registry_key_id: null },
      }), { status: 200 });
    }
    // package detail
    return new Response(JSON.stringify({
      namespace: `@${opts.scope}`, name: opts.name,
      display_name: null, description: "", type: "skill", license: "MIT",
      latest_version: opts.latestVersion, versions: [opts.latestVersion],
      publisher: { display_name: "T", tier: "official", mfa_enabled: true, github_username: null },
      sponsor: null, created_at: 0, updated_at: 0,
    }), { status: 200 });
  };
}

async function addMetafactorySource(env: TestEnv): Promise<void> {
  await saveSources(env.arc.sourcesPath, {
    sources: [
      { name: "mf", url: "https://meta-factory.test", tier: "official", enabled: true, type: "metafactory" },
    ],
  });
}

describe("checkUpgrades — registry-extracted package (arc#187)", () => {
  test("resolves newer version via metafactory API, not the YAML index", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    // Simulate a registry-extracted install: repo_url is a package ref.
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.7.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({ scope: "metafactory", name: "soma", latestVersion: "0.7.1", sha256: fixture.sha256 }));
    try {
      const results = await checkUpgrades(env.db, env.arc, env.host);
      const soma = results.find((r) => r.name === "soma")!;
      expect(soma.installedVersion).toBe("0.6.4");
      expect(soma.registryVersion).toBe("0.7.1");
      expect(soma.upgradable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("upgradePackage — registry-extracted package (arc#187)", () => {
  test("force-upgrades via clean re-download — no git pull error, DB updated", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.7.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({
      scope: "metafactory", name: "soma", latestVersion: "0.7.1", sha256: fixture.sha256, tarball: fixture.bytes,
    }));
    try {
      const result = await upgradePackage(env.db, env.arc, env.host, "soma", { force: true });
      expect(result.success).toBe(true);
      expect(result.oldVersion).toBe("0.6.4");
      expect(result.newVersion).toBe("0.7.1");
      // The defining symptom of bug 2 must be gone.
      expect(result.error ?? "").not.toContain("git pull failed");
      expect(result.error ?? "").not.toContain("not a git repository");

      const row = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("soma") as { version: string };
      expect(row.version).toBe("0.7.1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("never strands the user: a failed download leaves the prior install intact", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const installPath = (env.db.prepare("SELECT install_path FROM skills WHERE name = ?").get("soma") as { install_path: string }).install_path;
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
    await addMetafactorySource(env);

    const originalFetch = globalThis.fetch;
    // Storage download returns 401 (stale token) — the exact remove+install hazard.
    globalThis.fetch = mockFetch(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/storage/download/")) return new Response("denied", { status: 401 });
      if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
        return new Response(JSON.stringify({ version: "0.7.1", sha256: "deadbeef", manifest_canonical: "{}", signing: { registry_signature: null, registry_key_id: null } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        namespace: "@metafactory", name: "soma", display_name: null, description: "", type: "skill", license: "MIT",
        latest_version: "0.7.1", versions: ["0.7.1"],
        publisher: { display_name: "T", tier: "official", mfa_enabled: true, github_username: null }, sponsor: null, created_at: 0, updated_at: 0,
      }), { status: 200 });
    });
    try {
      const result = await upgradePackage(env.db, env.arc, env.host, "soma", { force: true });
      expect(result.success).toBe(false);
      // The working install is still on disk — not removed.
      expect(existsSync(installPath)).toBe(true);
      expect(existsSync(join(installPath, "arc-manifest.yaml"))).toBe(true);
      // DB still records the old version (no drift).
      const row = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("soma") as { version: string };
      expect(row.version).toBe("0.6.4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// arc#184 — soma tarball upgrade reproducer
// ---------------------------------------------------------------------------

describe("arc#184 — extracted-tarball upgrade and check", () => {
  test("upgrade --check reports the metafactory-available soma version", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.5.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.5.0", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.5.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({
      scope: "metafactory",
      name: "soma",
      latestVersion: "0.5.1",
      sha256: fixture.sha256,
    }));

    try {
      const results = await checkUpgrades(env.db, env.arc, env.host);
      const output = formatCheckResults(results);

      expect(output).toContain("soma: 0.5.0 → 0.5.1");
      expect(output).not.toContain("All packages are up to date.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("upgrade soma re-downloads a tarball extract instead of running git pull", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.5.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.5.0", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.5.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({
      scope: "metafactory",
      name: "soma",
      latestVersion: "0.5.1",
      sha256: fixture.sha256,
      tarball: fixture.bytes,
    }));

    try {
      const result = await upgradePackage(env.db, env.arc, env.host, "soma");

      expect(result.success).toBe(true);
      expect(result.oldVersion).toBe("0.5.0");
      expect(result.newVersion).toBe("0.5.1");
      expect(result.error ?? "").not.toContain("git pull failed");
      expect(result.error ?? "").not.toContain("not a git repository");

      const row = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("soma") as { version: string };
      expect(row.version).toBe("0.5.1");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
