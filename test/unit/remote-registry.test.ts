import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  fetchRemoteRegistry,
  searchAllSources,
  formatSourcedSearch,
} from "../../src/lib/remote-registry.js";
import type { RegistryConfig, SourcesConfig, RegistrySource } from "../../src/types.js";
import YAML from "yaml";
import { join } from "path";
import { writeFile, mkdir } from "fs/promises";

let env: TestEnv;

function sampleRemoteRegistry(): RegistryConfig {
  return {
    registry: {
      skills: [
        {
          name: "RemoteSkill",
          description: "A skill from a remote hub",
          author: "remoteauthor",
          source: "https://github.com/remote/skill/blob/main/SKILL.md",
          type: "community",
          status: "shipped",
        },
      ],
      agents: [],
      prompts: [],
      tools: [],
    },
  };
}

function localRegistry(): RegistryConfig {
  return {
    registry: {
      skills: [
        {
          name: "LocalSkill",
          description: "A local fallback skill",
          author: "localauthor",
          source: "https://github.com/local/skill/blob/main/SKILL.md",
          type: "builtin",
          status: "shipped",
        },
      ],
      agents: [],
      prompts: [],
      tools: [],
    },
  };
}

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("fetchRemoteRegistry", () => {
  test("reads from cache when fresh", async () => {
    const source: RegistrySource = {
      name: "test-hub",
      url: "https://example.com/nonexistent.yaml",
      tier: "community",
      enabled: true,
    };

    // Pre-populate cache
    await mkdir(env.paths.cachePath, { recursive: true });
    await writeFile(
      join(env.paths.cachePath, "test-hub.yaml"),
      YAML.stringify(sampleRemoteRegistry())
    );

    const result = await fetchRemoteRegistry(source, env.paths.cachePath);
    expect(result).not.toBeNull();
    expect(result!.registry.skills[0].name).toBe("RemoteSkill");
  });

  test("returns null for unreachable URL with no cache", async () => {
    const source: RegistrySource = {
      name: "unreachable",
      url: "https://does-not-exist.example.com/reg.yaml",
      tier: "community",
      enabled: true,
    };

    const result = await fetchRemoteRegistry(source, env.paths.cachePath);
    expect(result).toBeNull();
  });
});

describe("searchAllSources", () => {
  test("falls back to local registry when remotes fail", async () => {
    // Write local registry
    await Bun.write(
      env.paths.registryPath,
      YAML.stringify(localRegistry())
    );

    const sources: SourcesConfig = {
      sources: [
        {
          name: "unreachable",
          url: "https://does-not-exist.example.com/reg.yaml",
          tier: "community",
          enabled: true,
        },
      ],
    };

    const results = await searchAllSources(
      sources,
      "local",
      env.paths.cachePath,
      env.paths.registryPath
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sourceName).toBe("local");
    expect(results[0].entry.name).toBe("LocalSkill");
  });

  test("aggregates from cached sources", async () => {
    // Pre-populate cache for two sources
    await mkdir(env.paths.cachePath, { recursive: true });

    const reg1 = sampleRemoteRegistry();
    const reg2: RegistryConfig = {
      registry: {
        skills: [
          {
            name: "AnotherSkill",
            description: "Another remote skill",
            author: "author2",
            source: "https://github.com/a2/skill/blob/main/SKILL.md",
            type: "community",
            status: "shipped",
          },
        ],
        agents: [],
        prompts: [],
        tools: [],
      },
    };

    await writeFile(join(env.paths.cachePath, "hub-a.yaml"), YAML.stringify(reg1));
    await writeFile(join(env.paths.cachePath, "hub-b.yaml"), YAML.stringify(reg2));

    const sources: SourcesConfig = {
      sources: [
        { name: "hub-a", url: "https://example.com/a.yaml", tier: "community", enabled: true },
        { name: "hub-b", url: "https://example.com/b.yaml", tier: "official", enabled: true },
      ],
    };

    const results = await searchAllSources(
      sources,
      "skill",
      env.paths.cachePath,
      env.paths.registryPath
    );

    expect(results.length).toBe(2);
    const names = results.map((r) => r.entry.name);
    expect(names).toContain("RemoteSkill");
    expect(names).toContain("AnotherSkill");

    // Verify source tier annotation
    const remote = results.find((r) => r.entry.name === "RemoteSkill");
    expect(remote!.sourceName).toBe("hub-a");
    expect(remote!.sourceTier).toBe("community");

    const another = results.find((r) => r.entry.name === "AnotherSkill");
    expect(another!.sourceName).toBe("hub-b");
    expect(another!.sourceTier).toBe("official");
  });

  test("skips disabled sources", async () => {
    await mkdir(env.paths.cachePath, { recursive: true });
    await writeFile(
      join(env.paths.cachePath, "disabled-hub.yaml"),
      YAML.stringify(sampleRemoteRegistry())
    );

    const sources: SourcesConfig = {
      sources: [
        { name: "disabled-hub", url: "https://example.com/d.yaml", tier: "community", enabled: false },
      ],
    };

    const results = await searchAllSources(
      sources,
      "remote",
      env.paths.cachePath,
      env.paths.registryPath
    );

    // Should not find anything (disabled source skipped, no local fallback since no registry)
    expect(results).toHaveLength(0);
  });
});

describe("formatSourcedSearch", () => {
  test("formats results with source info", () => {
    const output = formatSourcedSearch([
      {
        entry: {
          name: "TestSkill",
          description: "A test skill",
          author: "tester",
          source: "https://github.com/test/skill",
          type: "community",
          status: "shipped",
        },
        artifactType: "skill",
        sourceName: "my-hub",
        sourceTier: "community",
      },
    ]);

    expect(output).toContain("TestSkill");
    expect(output).toContain("[community]");
    expect(output).toContain("my-hub");
    expect(output).toContain("tester");
  });

  test("returns no matches message for empty results", () => {
    const output = formatSourcedSearch([]);
    expect(output).toContain("No matches found");
  });
});
