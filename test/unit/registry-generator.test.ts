import { describe, test, expect } from "bun:test";
import YAML from "yaml";
import {
  sectionForType,
  tierToTrust,
  manifestDerivedFields,
  mergeEntry,
  generateRegistry,
  serializeRegistry,
  isStale,
  DEFAULT_STATUS,
  type ScannedRepo,
} from "../../src/lib/registry-generator.js";
import type { ArcManifest, RegistryConfig, RegistryEntry } from "../../src/types.js";

function manifest(over: Partial<ArcManifest> = {}): ArcManifest {
  return {
    schema: "arc/v1",
    name: "widget",
    version: "1.2.3",
    type: "skill",
    tier: "custom",
    description: "A widget skill",
    author: { name: "Andreas Aastroem", github: "mellanon" },
    ...over,
  };
}

function repo(over: Partial<ScannedRepo> = {}): ScannedRepo {
  return {
    source: "https://github.com/the-metafactory/widget",
    manifest: manifest(),
    ...over,
  };
}

describe("sectionForType", () => {
  test("maps each manifest type to its section", () => {
    expect(sectionForType("skill")).toBe("skills");
    expect(sectionForType("bundle")).toBe("skills");
    expect(sectionForType("agent")).toBe("agents");
    expect(sectionForType("prompt")).toBe("prompts");
    expect(sectionForType("tool")).toBe("tools");
    expect(sectionForType("library")).toBe("tools");
    expect(sectionForType("component")).toBe("components");
    expect(sectionForType("rules")).toBe("rules");
    expect(sectionForType(undefined)).toBe("skills");
  });
});

describe("tierToTrust", () => {
  test("community stays community; everything else collapses to custom", () => {
    expect(tierToTrust("community")).toBe("community");
    expect(tierToTrust("custom")).toBe("custom");
    expect(tierToTrust("official")).toBe("custom");
    expect(tierToTrust("core")).toBe("custom");
    expect(tierToTrust(undefined)).toBe("custom");
  });
});

describe("manifestDerivedFields", () => {
  test("derives the manifest-authoritative slice", () => {
    const f = manifestDerivedFields(repo());
    expect(f).toMatchObject({
      name: "widget",
      description: "A widget skill",
      author: "mellanon",
      version: "1.2.3",
      source: "https://github.com/the-metafactory/widget",
      trust: "custom",
    });
    expect((f as Record<string, unknown>).has_cli).toBeUndefined();
    expect((f as Record<string, unknown>).bundle).toBeUndefined();
  });

  test("external repo is forced to community regardless of manifest tier", () => {
    const f = manifestDerivedFields(repo({ external: true, manifest: manifest({ tier: "official" }) }));
    expect(f.trust).toBe("community");
  });

  test("has_cli set when the manifest provides a cli; bundle set for type bundle", () => {
    const f = manifestDerivedFields(
      repo({
        manifest: manifest({ type: "bundle", provides: { cli: [{ command: "bun x", name: "x" }] } } as unknown as Partial<ArcManifest>),
      }),
    );
    expect((f as Record<string, unknown>).has_cli).toBe(true);
    expect((f as Record<string, unknown>).bundle).toBe(true);
  });

  test("falls back to the-metafactory when the manifest has no author github", () => {
    const f = manifestDerivedFields(repo({ manifest: manifest({ author: { name: "x" } } as Partial<ArcManifest>) }));
    expect(f.author).toBe("the-metafactory");
  });
});

describe("mergeEntry", () => {
  test("new entry gets the default status", () => {
    const e = mergeEntry(manifestDerivedFields(repo({ manifest: manifest({ name: "widget", version: "1.0.0" }) })), undefined);
    expect(e.status).toBe(DEFAULT_STATUS);
    expect(e.name).toBe("widget");
  });

  test("preserves curated fields while overwriting manifest-authoritative ones", () => {
    const existing = {
      name: "arc",
      description: "old desc",
      author: "metafactory",
      contributors: ["mellanon", "jcfischer"],
      version: "0.12.1",
      source: "https://github.com/the-metafactory/arc",
      trust: "custom",
      status: "shipped",
      core: true,
      has_cli: true,
    } as unknown as RegistryEntry;
    const derived = manifestDerivedFields(
      repo({ source: "https://github.com/the-metafactory/arc", manifest: manifest({ name: "arc", version: "0.40.3", type: "tool", description: "Agentic component package manager" }) }),
    );
    const merged = mergeEntry(derived, existing) as unknown as Record<string, unknown>;
    // Manifest-authoritative fields updated:
    expect(merged.version).toBe("0.40.3");
    expect(merged.description).toBe("Agentic component package manager");
    // Curated fields preserved:
    expect(merged.contributors).toEqual(["mellanon", "jcfischer"]);
    expect(merged.core).toBe(true);
    expect(merged.status).toBe("shipped");
  });
});

describe("generateRegistry", () => {
  test("adds new entries and reports them; sections are name-sorted", () => {
    const scanned = [
      repo({ source: "https://github.com/the-metafactory/zebra", manifest: manifest({ name: "zebra" }) }),
      repo({ source: "https://github.com/the-metafactory/apple", manifest: manifest({ name: "apple" }) }),
    ];
    const res = generateRegistry(scanned, null);
    expect(res.config.registry.skills.map((e) => e.name)).toEqual(["apple", "zebra"]);
    expect(res.added.map((a) => a.name).sort()).toEqual(["apple", "zebra"]);
    expect(res.updated).toHaveLength(0);
  });

  test("updates a stale version and reports it as updated", () => {
    const existing: RegistryConfig = {
      registry: {
        skills: [],
        agents: [],
        prompts: [],
        tools: [
          { name: "arc", description: "d", author: "metafactory", version: "0.12.1", source: "https://github.com/the-metafactory/arc", trust: "custom", status: "shipped", core: true } as unknown as RegistryEntry,
        ],
        components: [],
        rules: [],
      },
    };
    const scanned = [repo({ source: "https://github.com/the-metafactory/arc", manifest: manifest({ name: "arc", type: "tool", version: "0.40.3" }) })];
    const res = generateRegistry(scanned, existing);
    expect(res.updated.map((u) => u.name)).toEqual(["arc"]);
    const arc = res.config.registry.tools.find((e) => e.name === "arc") as unknown as Record<string, unknown>;
    expect(arc.version).toBe("0.40.3");
    expect(arc.core).toBe(true); // curated field preserved
  });

  test("preserves existing entries that were not scanned", () => {
    const existing: RegistryConfig = {
      registry: {
        skills: [],
        agents: [
          { name: "gorse", description: "aspirational", author: "mellanon", source: "https://github.com/the-metafactory/gorse", trust: "custom", status: "designed" } as unknown as RegistryEntry,
        ],
        prompts: [], tools: [], components: [], rules: [],
      },
    };
    const res = generateRegistry([], existing);
    expect(res.config.registry.agents.map((e) => e.name)).toEqual(["gorse"]);
    expect(res.preserved.map((p) => p.name)).toEqual(["gorse"]);
  });

  test("re-running against its own output is a no-op (idempotent/deterministic)", () => {
    const scanned = [
      repo({ source: "https://github.com/the-metafactory/beta", manifest: manifest({ name: "beta" }) }),
      repo({ source: "https://github.com/the-metafactory/alpha", manifest: manifest({ name: "alpha", type: "tool" }) }),
    ];
    const first = generateRegistry(scanned, null);
    const second = generateRegistry(scanned, first.config);
    expect(serializeRegistry(second.config)).toBe(serializeRegistry(first.config));
    expect(second.added).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
  });
});

describe("serializeRegistry + isStale", () => {
  test("output carries the generated header and is parseable", () => {
    const res = generateRegistry([repo()], null);
    const yaml = serializeRegistry(res.config);
    expect(yaml).toContain("GENERATED from org scan");
    const parsed = YAML.parse(yaml) as RegistryConfig;
    expect(parsed.registry.skills[0].name).toBe("widget");
  });

  test("deterministic: same input yields byte-identical output", () => {
    const scanned = [repo()];
    expect(serializeRegistry(generateRegistry(scanned, null).config)).toBe(
      serializeRegistry(generateRegistry(scanned, null).config),
    );
  });

  test("isStale detects drift and ignores trailing-whitespace/EOL differences", () => {
    const a = serializeRegistry(generateRegistry([repo()], null).config);
    expect(isStale(a, a)).toBe(false);
    expect(isStale(a + "\n\n", a)).toBe(false);
    expect(isStale(a.replace("1.2.3", "9.9.9"), a)).toBe(true);
    expect(isStale("", a)).toBe(true);
  });
});
