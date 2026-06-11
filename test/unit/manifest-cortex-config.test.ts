/**
 * F-6a (cortex#858) — `cortex_config` manifest field validation +
 * round-trip. Covers the structural pre-filter arc applies at manifest-read
 * time (capability/policy-only boundary; inline-vs-path mutual exclusivity;
 * relative-path guard). cortex's `CapabilityMergeFragmentSchema` owns the deep
 * semantics at merge time — these tests assert only arc's edge contract.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { readManifest, validateCortexConfig } from "../../src/lib/manifest.js";
import type { ArcManifest } from "../../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arc-cortex-config-manifest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write an arc-manifest.yaml from an object and read it back through the parser. */
async function roundTrip(manifest: Record<string, unknown>): Promise<ArcManifest | null> {
  await writeFile(join(dir, "arc-manifest.yaml"), YAML.stringify(manifest), "utf-8");
  return readManifest(dir);
}

const baseAgent = {
  name: "dev-agent",
  version: "1.0.0",
  type: "agent",
};

describe("validateCortexConfig — inline form", () => {
  test("accepts capabilities-only", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: { capabilities: [{ id: "dev.implement" }] } } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).not.toThrow();
  });

  test("accepts policy-only", () => {
    expect(() =>
      validateCortexConfig(
        {
          ...baseAgent,
          cortex_config: { policy: { principals: [{ id: "dev-agent" }], roles: [] } },
        } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).not.toThrow();
  });

  test("accepts both capabilities + policy", () => {
    expect(() =>
      validateCortexConfig(
        {
          ...baseAgent,
          cortex_config: {
            capabilities: [{ id: "dev.implement" }],
            policy: { principals: [], roles: [{ id: "develop" }] },
          },
        } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).not.toThrow();
  });

  test("rejects a smuggled transport/identity key (agents)", () => {
    expect(() =>
      validateCortexConfig(
        {
          ...baseAgent,
          cortex_config: { capabilities: [], agents: [{ id: "x" }] },
        } as unknown as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/may only declare 'capabilities' and\/or 'policy'/);
  });

  test("rejects an empty inline fragment (no capabilities, no policy)", () => {
    // An object with only an unknown key is caught by the unknown-key guard;
    // a truly empty object is caught by the empty guard.
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: {} } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/is empty/);
  });

  test("rejects capabilities that is not an array", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: { capabilities: "nope" } } as unknown as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/capabilities' must be an array/);
  });

  test("rejects policy that is not an object", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: { policy: [] } } as unknown as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/policy' must be an object/);
  });
});

describe("validateCortexConfig — path-pointer form", () => {
  test("accepts a relative path pointer", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: { path: "cortex-config.yaml" } } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).not.toThrow();
  });

  test("rejects an absolute path", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: { path: "/etc/passwd" } } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/must be a relative path/);
  });

  test("rejects a path with .. traversal", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: { path: "../escape.yaml" } } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/must not contain '\.\.'/);
  });

  test("rejects path + inline keys together (mutual exclusivity)", () => {
    expect(() =>
      validateCortexConfig(
        {
          ...baseAgent,
          cortex_config: { path: "f.yaml", capabilities: [] },
        } as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/both a 'path' pointer and inline/);
  });
});

describe("validateCortexConfig — non-object", () => {
  test("rejects a string", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: "nope" } as unknown as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/must be an object/);
  });

  test("rejects an array", () => {
    expect(() =>
      validateCortexConfig(
        { ...baseAgent, cortex_config: [] } as unknown as ArcManifest,
        "arc-manifest.yaml",
      ),
    ).toThrow(/must be an object/);
  });

  test("no-op when absent", () => {
    expect(() =>
      validateCortexConfig(baseAgent as ArcManifest, "arc-manifest.yaml"),
    ).not.toThrow();
  });
});

describe("readManifest — cortex_config round-trips through the parser", () => {
  test("a valid inline fragment survives parse + validation", async () => {
    const fragment = {
      capabilities: [
        { id: "dev.implement", description: "Dev agent implementation", provided_by: ["dev-agent"] },
      ],
      policy: { principals: [{ id: "dev-agent", role: ["develop"] }], roles: [{ id: "develop", capabilities: ["dev.implement"] }] },
    };
    const m = await roundTrip({ ...baseAgent, cortex_config: fragment });
    expect(m).not.toBeNull();
    expect(m!.cortex_config).toEqual(fragment);
  });

  test("a path-pointer fragment survives parse", async () => {
    const m = await roundTrip({ ...baseAgent, cortex_config: { path: "cortex-config.yaml" } });
    expect(m!.cortex_config).toEqual({ path: "cortex-config.yaml" });
  });

  test("an invalid fragment makes readManifest throw", async () => {
    await writeFile(
      join(dir, "arc-manifest.yaml"),
      YAML.stringify({ ...baseAgent, cortex_config: { nats: { subjects: [] } } }),
      "utf-8",
    );
    await expect(readManifest(dir)).rejects.toThrow(/may only declare 'capabilities'/);
  });

  test("a manifest WITHOUT cortex_config parses unchanged", async () => {
    const m = await roundTrip(baseAgent);
    expect(m!.cortex_config).toBeUndefined();
  });
});
