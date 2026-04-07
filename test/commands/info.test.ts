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
