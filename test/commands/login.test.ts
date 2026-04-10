import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { login } from "../../src/commands/login.js";
import { saveSources, loadSources } from "../../src/lib/sources.js";
import type { SourcesConfig } from "../../src/types.js";
import YAML from "yaml";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

function metafactorySource(token?: string): SourcesConfig {
  return {
    sources: [{
      name: "mf-test",
      url: "https://meta-factory.ai",
      tier: "official",
      enabled: true,
      type: "metafactory",
      ...(token ? { token } : {}),
    }],
  };
}

function registrySource(): SourcesConfig {
  return {
    sources: [{
      name: "my-registry",
      url: "https://example.com/REG.yaml",
      tier: "community",
      enabled: true,
    }],
  };
}

describe("login - source finding", () => {
  test("returns error when no metafactory source configured", async () => {
    await saveSources(env.paths.sourcesPath, registrySource());
    const result = await login({ paths: env.paths });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No metafactory source configured");
  });

  test("returns error when --source name not found", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource());
    const result = await login({ paths: env.paths, sourceName: "nonexistent" });
    expect(result.success).toBe(false);
    expect(result.error).toContain('"nonexistent" not found');
  });

  test("returns error when source is type registry", async () => {
    await saveSources(env.paths.sourcesPath, registrySource());
    const result = await login({ paths: env.paths, sourceName: "my-registry" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("registry");
    expect(result.error).toContain("not \"metafactory\"");
  });

  test("finds first metafactory source by default", async () => {
    const config: SourcesConfig = {
      sources: [
        { name: "reg", url: "https://example.com/R.yaml", tier: "community", enabled: true },
        { name: "mf", url: "https://meta-factory.ai", tier: "official", enabled: true, type: "metafactory" },
      ],
    };
    await saveSources(env.paths.sourcesPath, config);
    // Will fail at network call, but proves it found the right source
    const result = await login({ paths: env.paths });
    // Either network error (expected) or already logged in -- not "no source" error
    expect(result.error).not.toContain("No metafactory source configured");
  });
});

describe("login - already logged in", () => {
  test("returns error when token exists and no --force", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource("existing-token"));
    const result = await login({ paths: env.paths });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Already logged in");
  });

  test("proceeds when token exists and --force", async () => {
    await saveSources(env.paths.sourcesPath, metafactorySource("existing-token"));
    // Will fail at network call, but proves it didn't stop at "already logged in"
    const result = await login({ paths: env.paths, force: true });
    expect(result.error).not.toContain("Already logged in");
  });
});
