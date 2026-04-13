import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  fetchRemoteRegistry,
  searchAllSources,
  formatSourcedSearch,
  rewriteRawToContentsApi,
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

  test("emits warning to stderr on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Not Found", { status: 404, statusText: "Not Found" })) as typeof fetch;
    (globalThis.fetch as any).preconnect = () => {};

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;

    const source: RegistrySource = {
      name: "broken-hub",
      url: "https://example.com/missing.yaml",
      tier: "community",
      enabled: true,
    };

    try {
      const result = await fetchRemoteRegistry(source, env.paths.cachePath, true);
      expect(result).toBeNull();
      const output = stderrChunks.join("");
      expect(output).toContain("broken-hub");
      expect(output).toContain("404");
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalWrite;
    }
  });

  test("emits warning with auth hint on 401", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
    (globalThis.fetch as any).preconnect = () => {};

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;

    const source: RegistrySource = {
      name: "private-hub",
      url: "https://example.com/private.yaml",
      tier: "community",
      enabled: true,
    };

    try {
      const result = await fetchRemoteRegistry(source, env.paths.cachePath, true);
      expect(result).toBeNull();
      const output = stderrChunks.join("");
      expect(output).toContain("private-hub");
      expect(output).toContain("401");
      expect(output).toContain("GITHUB_TOKEN");
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalWrite;
    }
  });

  test("emits warning on network error and falls back to stale cache", async () => {
    const source: RegistrySource = {
      name: "flaky-hub",
      url: "https://example.com/flaky.yaml",
      tier: "community",
      enabled: true,
    };

    // Pre-populate stale cache
    await mkdir(env.paths.cachePath, { recursive: true });
    await writeFile(
      join(env.paths.cachePath, "flaky-hub.yaml"),
      YAML.stringify(sampleRemoteRegistry()),
    );

    // Force refresh with network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    (globalThis.fetch as any).preconnect = () => {};

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrChunks.push(String(chunk)); return true; }) as any;

    try {
      const result = await fetchRemoteRegistry(source, env.paths.cachePath, true);
      // Should fall back to stale cache
      expect(result).not.toBeNull();
      expect(result!.registry.skills[0].name).toBe("RemoteSkill");
      const output = stderrChunks.join("");
      expect(output).toContain("flaky-hub");
      expect(output).toContain("ECONNREFUSED");
      expect(output).toContain("stale cache");
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalWrite;
    }
  });
});

describe("searchAllSources", () => {
  test("returns empty when all remotes fail", async () => {
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
      "anything",
      env.paths.cachePath
    );

    expect(results).toHaveLength(0);
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
      env.paths.cachePath
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
      env.paths.cachePath
    );

    // Should not find anything (disabled source skipped, no local fallback since no registry)
    expect(results).toHaveLength(0);
  });
});

describe("rewriteRawToContentsApi", () => {
  test("rewrites a raw.githubusercontent.com URL to the Contents API", () => {
    const out = rewriteRawToContentsApi(
      "https://raw.githubusercontent.com/the-metafactory/meta-factory/main/REGISTRY.yaml",
    );
    expect(out).toBe(
      "https://api.github.com/repos/the-metafactory/meta-factory/contents/REGISTRY.yaml?ref=main",
    );
  });

  test("preserves nested paths", () => {
    const out = rewriteRawToContentsApi(
      "https://raw.githubusercontent.com/owner/repo/branch/path/to/file.yaml",
    );
    expect(out).toBe(
      "https://api.github.com/repos/owner/repo/contents/path/to/file.yaml?ref=branch",
    );
  });

  test("encodes refs containing slashes", () => {
    const out = rewriteRawToContentsApi(
      "https://raw.githubusercontent.com/owner/repo/release%2Fv1/file.yaml",
    );
    expect(out).not.toBeNull();
    expect(out).toContain("?ref=");
  });

  test("returns null for non-raw URLs", () => {
    expect(rewriteRawToContentsApi("https://example.com/file.yaml")).toBeNull();
    expect(
      rewriteRawToContentsApi("https://api.github.com/repos/o/r/contents/f.yaml"),
    ).toBeNull();
    expect(rewriteRawToContentsApi("file:///tmp/registry.yaml")).toBeNull();
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
