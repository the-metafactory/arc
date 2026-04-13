import { describe, test, expect, afterEach } from "bun:test";
import { info, formatInfo, formatInfoJson } from "../../src/commands/info.js";
import { install } from "../../src/commands/install.js";
import { createTestEnv, createMockSkillRepo, createMockLibraryRepo, type TestEnv } from "../helpers/test-env.js";
import { writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

describe("info — installed packages", () => {
  test("shows info for an installed skill", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, { name: "test-skill" });

    await install({ paths: env.paths, db: env.db, repoUrl: repo.url, yes: true });

    const result = await info(env.db, "test-skill");
    expect(result.skill).not.toBeNull();
    expect(result.skill!.name).toBe("test-skill");
    expect(result.manifest).not.toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("shows info for an installed library", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    const result = await info(env.db, "test-lib");
    expect(result.skill).toBeNull();
    expect(result.libraryArtifacts).toHaveLength(2);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.type).toBe("library");
  });

  test("shows info for a specific artifact in an installed library", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    const result = await info(env.db, "test-lib:alpha");
    expect(result.skill).not.toBeNull();
    expect(result.skill!.name).toBe("alpha");
    expect(result.manifest).not.toBeNull();
  });

  test("returns error for non-existent artifact in installed library", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
      ],
    });

    await install({ paths: env.paths, db: env.db, repoUrl: lib.url, yes: true });

    const result = await info(env.db, "test-lib:nope");
    expect(result.error).toContain("not found in library");
  });

  test("returns error for non-installed package without paths", async () => {
    env = await createTestEnv();

    const result = await info(env.db, "nonexistent");
    expect(result.error).toBe("'nonexistent' is not installed");
  });
});

describe("info — remote packages", () => {
  test("resolves info for an uninstalled package from registry", async () => {
    env = await createTestEnv();

    // Create a mock skill repo that will be the "remote" package
    const repo = await createMockSkillRepo(env.root, {
      name: "remote-skill",
      version: "2.0.0",
      author: "remote-author",
    });

    // Set up a local registry source pointing to a registry that contains this package
    const registryContent = YAML.stringify({
      registry: {
        skills: [{
          name: "remote-skill",
          description: "A remote skill for testing",
          source: repo.url,
          type: "skill",
          author: "remote-author",
          status: "shipped",
        }],
        agents: [],
        prompts: [],
        tools: [],
        components: [],
        rules: [],
      },
    });

    const registryFile = join(env.root, "test-registry.yaml");
    await writeFile(registryFile, registryContent);

    // Configure sources to use our local file registry
    const sourcesContent = YAML.stringify({
      sources: [{
        name: "test-source",
        url: `file://${registryFile}`,
        tier: "community",
        enabled: true,
      }],
    });
    await writeFile(env.paths.sourcesPath, sourcesContent);

    const result = await info(env.db, "remote-skill", env.paths);

    expect(result.error).toBeUndefined();
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.name).toBe("remote-skill");
    expect(result.manifest!.version).toBe("2.0.0");
    expect(result.remote).not.toBeUndefined();
    expect(result.remote!.sourceName).toBe("test-source");
    expect(result.remote!.sourceTier).toBe("community");
    expect(result.skill).toBeNull();
  });

  test("resolves info for an uninstalled library from registry", async () => {
    env = await createTestEnv();

    const lib = await createMockLibraryRepo(env.root, {
      name: "remote-lib",
      version: "1.5.0",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", description: "Alpha skill" },
        { path: "skills/beta", name: "beta", type: "skill", description: "Beta skill" },
      ],
    });

    const registryContent = YAML.stringify({
      registry: {
        skills: [{
          name: "remote-lib",
          description: "A remote library",
          source: lib.url,
          type: "skill",
          author: "test-author",
          status: "shipped",
        }],
        agents: [],
        prompts: [],
        tools: [],
        components: [],
        rules: [],
      },
    });

    const registryFile = join(env.root, "test-registry.yaml");
    await writeFile(registryFile, registryContent);
    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{ name: "test-source", url: `file://${registryFile}`, tier: "community", enabled: true }],
    }));

    const result = await info(env.db, "remote-lib", env.paths);

    expect(result.error).toBeUndefined();
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.type).toBe("library");
    expect(result.manifest!.artifacts).toHaveLength(2);
    expect(result.remote).not.toBeUndefined();
  });

  test("resolves info for a specific artifact in an uninstalled library", async () => {
    env = await createTestEnv();

    const lib = await createMockLibraryRepo(env.root, {
      name: "remote-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    const registryFile = join(env.root, "test-registry.yaml");
    await writeFile(registryFile, YAML.stringify({
      registry: {
        skills: [{ name: "remote-lib", description: "lib", source: lib.url, type: "skill", author: "test", status: "shipped" }],
        agents: [], prompts: [], tools: [], components: [], rules: [],
      },
    }));
    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{ name: "test-source", url: `file://${registryFile}`, tier: "community", enabled: true }],
    }));

    const result = await info(env.db, "remote-lib:alpha", env.paths);

    expect(result.error).toBeUndefined();
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.name).toBe("alpha");
    expect(result.remote).not.toBeUndefined();
  });

  test("returns error for non-existent artifact in uninstalled library", async () => {
    env = await createTestEnv();

    const lib = await createMockLibraryRepo(env.root, {
      name: "remote-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
      ],
    });

    const registryFile = join(env.root, "test-registry.yaml");
    await writeFile(registryFile, YAML.stringify({
      registry: {
        skills: [{ name: "remote-lib", description: "lib", source: lib.url, type: "skill", author: "test", status: "shipped" }],
        agents: [], prompts: [], tools: [], components: [], rules: [],
      },
    }));
    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{ name: "test-source", url: `file://${registryFile}`, tier: "community", enabled: true }],
    }));

    const result = await info(env.db, "remote-lib:nope", env.paths);

    expect(result.error).toContain("not found in library");
  });

  test("returns error when package not found in any source", async () => {
    env = await createTestEnv();

    const registryFile = join(env.root, "test-registry.yaml");
    await writeFile(registryFile, YAML.stringify({
      registry: { skills: [], agents: [], prompts: [], tools: [], components: [], rules: [] },
    }));
    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{ name: "test-source", url: `file://${registryFile}`, tier: "community", enabled: true }],
    }));

    const result = await info(env.db, "nonexistent", env.paths);

    expect(result.error).toContain("not found");
    expect(result.error).toContain("not installed and not in any configured source");
  });
});

describe("formatInfo — remote packages", () => {
  test("formats remote standalone package with install hint", () => {
    const result = formatInfo({
      skill: null,
      manifest: {
        name: "my-skill",
        version: "1.0.0",
        type: "skill",
        capabilities: {
          filesystem: { read: ["./"], write: [] },
          network: [],
          bash: { allowed: false },
          secrets: [],
        },
      } as any,
      releaseNotes: null,
      remote: { sourceName: "metafactory", sourceTier: "community", repoUrl: "https://github.com/test/repo" },
    });

    expect(result).toContain("my-skill");
    expect(result).toContain("v1.0.0");
    expect(result).toContain("community");
    expect(result).toContain("arc install my-skill");
  });

  test("formats remote library with artifact list and install hints", () => {
    const result = formatInfo({
      skill: null,
      manifest: {
        name: "my-lib",
        version: "2.0.0",
        type: "library",
        artifacts: [
          { path: "skills/alpha", description: "Alpha skill" },
          { path: "skills/beta", description: "Beta skill" },
        ],
      } as any,
      releaseNotes: null,
      remote: { sourceName: "metafactory", sourceTier: "community", repoUrl: "https://github.com/test/lib" },
    });

    expect(result).toContain("my-lib");
    expect(result).toContain("v2.0.0");
    expect(result).toContain("library");
    expect(result).toContain("Artifacts (2)");
    expect(result).toContain("Alpha skill");
    expect(result).toContain("arc install my-lib");
    expect(result).toContain("arc install my-lib:<artifact-name>");
  });
});

describe("formatInfoJson", () => {
  test("outputs JSON for installed package", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, { name: "json-test" });
    await install({ paths: env.paths, db: env.db, repoUrl: repo.url, yes: true });

    const result = await info(env.db, "json-test");
    const json = JSON.parse(formatInfoJson(result));

    expect(json.name).toBe("json-test");
    expect(json.installed).toBe(true);
    expect(json.status).toBe("active");
  });

  test("outputs JSON for remote package", () => {
    const json = JSON.parse(formatInfoJson({
      skill: null,
      manifest: {
        name: "remote-pkg",
        version: "1.0.0",
        type: "skill",
        capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
      } as any,
      releaseNotes: null,
      remote: { sourceName: "test-source", sourceTier: "community", repoUrl: "https://github.com/test/repo" },
    }));

    expect(json.name).toBe("remote-pkg");
    expect(json.installed).toBe(false);
    expect(json.source).toBe("test-source");
    expect(json.source_tier).toBe("community");
  });

  test("outputs JSON error for missing package", () => {
    const json = JSON.parse(formatInfoJson({
      skill: null,
      manifest: null,
      releaseNotes: null,
      error: "not found",
    }));

    expect(json.error).toBe("not found");
  });
});

describe("info — metafactory API packages (@scope/name)", () => {
  let savedFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (savedFetch) globalThis.fetch = savedFetch;
  });

  const capturedUrls: string[] = [];

  function mockApiDetail(detail: Record<string, unknown>) {
    savedFetch = globalThis.fetch;
    capturedUrls.length = 0;
    (globalThis as any).fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      capturedUrls.push(url);
      if (url.includes("/api/v1/packages/")) {
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };
  }

  test("resolves info for @scope/name from metafactory API", async () => {
    env = await createTestEnv();

    // Configure a metafactory source
    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{
        name: "mf-test",
        url: "https://api.example.com",
        tier: "community",
        enabled: true,
        type: "metafactory",
        token: "test-token",
      }],
    }));

    mockApiDetail({
      namespace: "jcfischer",
      name: "demo-skill",
      display_name: "Demo Skill",
      description: "A demo skill for testing",
      type: "skill",
      license: "MIT",
      latest_version: "0.1.0",
      versions: ["0.1.0"],
      publisher: {
        display_name: "Jens-Christian Fischer",
        tier: "steward",
        mfa_enabled: true,
        github_username: "jcfischer",
      },
      sponsor: null,
      created_at: 1700000000,
      updated_at: 1700000000,
    });

    const result = await info(env.db, "@jcfischer/demo-skill", env.paths);

    expect(result.error).toBeUndefined();
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.name).toBe("demo-skill");
    expect(result.manifest!.version).toBe("0.1.0");
    expect(result.manifest!.type).toBe("skill");
    expect(result.manifest!.description).toBe("A demo skill for testing");
    expect(result.remote).toBeDefined();
    expect(result.remote!.sourceName).toBe("mf-test");
    expect(result.skill).toBeNull();

    // Verify API was called with correct scope and name in URL
    expect(capturedUrls.some((u) => u.includes("/%40jcfischer/demo-skill"))).toBe(true);
  });

  test("returns error when @scope/name not found in any API source", async () => {
    env = await createTestEnv();

    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{
        name: "mf-test",
        url: "https://api.example.com",
        tier: "community",
        enabled: true,
        type: "metafactory",
        token: "test-token",
      }],
    }));

    savedFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response('{"error":"Not found"}', { status: 404 });

    const result = await info(env.db, "@jcfischer/nonexistent", env.paths);

    expect(result.error).toContain("not found");
  });

  test("shows publisher info in formatted output", async () => {
    const result = formatInfo({
      skill: null,
      manifest: {
        name: "demo-skill",
        version: "0.1.0",
        type: "skill",
        description: "A demo skill",
        author: { name: "Jens-Christian Fischer", github: "jcfischer" },
      } as any,
      releaseNotes: null,
      remote: {
        sourceName: "metafactory",
        sourceTier: "community",
        repoUrl: "@jcfischer/demo-skill",
      },
    });

    expect(result).toContain("demo-skill");
    expect(result).toContain("v0.1.0");
    expect(result).toContain("Jens-Christian Fischer");
    expect(result).toContain("arc install");
  });

  test("formats @scope/name in install hint for API packages", async () => {
    env = await createTestEnv();

    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{
        name: "mf-test",
        url: "https://api.example.com",
        tier: "community",
        enabled: true,
        type: "metafactory",
        token: "test-token",
      }],
    }));

    mockApiDetail({
      namespace: "jcfischer",
      name: "demo-skill",
      display_name: null,
      description: "A demo",
      type: "skill",
      license: "MIT",
      latest_version: "1.0.0",
      versions: ["1.0.0"],
      publisher: { display_name: "JCF", tier: "identified", mfa_enabled: false, github_username: "jcfischer" },
      sponsor: null,
      created_at: 1700000000,
      updated_at: 1700000000,
    });

    const result = await info(env.db, "@jcfischer/demo-skill", env.paths);
    const formatted = formatInfo(result);

    expect(formatted).toContain("arc install @jcfischer/demo-skill");
  });

  test("JSON output includes API metadata", async () => {
    env = await createTestEnv();

    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{
        name: "mf-test",
        url: "https://api.example.com",
        tier: "community",
        enabled: true,
        type: "metafactory",
        token: "test-token",
      }],
    }));

    mockApiDetail({
      namespace: "jcfischer",
      name: "demo-skill",
      display_name: "Demo",
      description: "A demo",
      type: "skill",
      license: "MIT",
      latest_version: "1.0.0",
      versions: ["1.0.0", "0.9.0"],
      publisher: { display_name: "JCF", tier: "steward", mfa_enabled: true, github_username: "jcfischer" },
      sponsor: null,
      created_at: 1700000000,
      updated_at: 1700000000,
    });

    const result = await info(env.db, "@jcfischer/demo-skill", env.paths);
    const json = JSON.parse(formatInfoJson(result));

    expect(json.installed).toBe(false);
    expect(json.name).toBe("demo-skill");
    expect(json.source).toBe("mf-test");
    expect(json.versions).toEqual(["1.0.0", "0.9.0"]);
    expect(json.publisher).toBeDefined();
    expect(json.publisher.tier).toBe("steward");
  });

  test("JSON output includes sponsor when present", async () => {
    env = await createTestEnv();

    await writeFile(env.paths.sourcesPath, YAML.stringify({
      sources: [{
        name: "mf-test",
        url: "https://api.example.com",
        tier: "community",
        enabled: true,
        type: "metafactory",
        token: "test-token",
      }],
    }));

    mockApiDetail({
      namespace: "jcfischer",
      name: "sponsored-skill",
      display_name: null,
      description: "A sponsored skill",
      type: "skill",
      license: "MIT",
      latest_version: "1.0.0",
      versions: ["1.0.0"],
      publisher: { display_name: "JCF", tier: "identified", mfa_enabled: false, github_username: "jcfischer" },
      sponsor: { display_name: "metafactory", tier: "steward", github_username: "mellanon" },
      created_at: 1700000000,
      updated_at: 1700000000,
    });

    const result = await info(env.db, "@jcfischer/sponsored-skill", env.paths);
    const json = JSON.parse(formatInfoJson(result));

    expect(json.sponsor).toBeDefined();
    expect(json.sponsor.display_name).toBe("metafactory");
    expect(json.sponsor.tier).toBe("steward");
  });
});
