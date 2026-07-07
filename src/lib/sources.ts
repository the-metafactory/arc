import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import YAML from "yaml";
import type { SourcesConfig, RegistrySource, SourceType } from "../types.js";

/** Valid source types */
export const VALID_SOURCE_TYPES: readonly SourceType[] = ["registry", "metafactory"];

// The metafactory API source -- the sole default. The registry API client
// (F-3) has landed: remote-registry.ts routes type:"metafactory" sources to
// metafactory-api.ts, so this source fully serves search/install on its own.
const DEFAULT_API_SOURCE: RegistrySource = {
  name: "metafactory",
  url: "https://meta-factory.ai",
  type: "metafactory",
  tier: "official",
  enabled: true,
};

// Known-dead default sources that older arc versions baked into every install.
// The metafactory-registry REGISTRY.yaml fallback (the F-1..F-3 window bridge)
// is retired: the-metafactory/meta-factory is not public, so the raw URL 404s
// on every `arc search` (arc#267). pruneKnownDeadSources() drops these from an
// existing sources.yaml on load so the warning self-clears -- but only when a
// source still matches the exact baked-in signature (name AND url), leaving a
// user who repurposed the name untouched.
const KNOWN_DEAD_DEFAULT_SOURCES: readonly { name: string; url: string }[] = [
  {
    name: "metafactory-registry",
    url: "https://raw.githubusercontent.com/the-metafactory/meta-factory/main/REGISTRY.yaml",
  },
];

export async function loadSources(
  sourcesPath: string
): Promise<SourcesConfig> {
  if (!existsSync(sourcesPath)) {
    const config = createDefaultSources();
    await saveSources(sourcesPath, config);
    return config;
  }

  const content = await readFile(sourcesPath, "utf-8");
  const parsed = YAML.parse(content) as Partial<SourcesConfig> | null;

  if (!parsed?.sources || !Array.isArray(parsed.sources)) {
    return createDefaultSources();
  }

  const config = parsed as SourcesConfig;
  // Self-heal (arc#267): drop the known-dead default source so its 404 fetch
  // warning clears without a manual `arc source remove`. One-time -- once the
  // rewrite lands the dead source is gone, so subsequent loads don't re-save.
  if (pruneKnownDeadSources(config)) {
    await saveSources(sourcesPath, config);
  }
  return config;
}

export function createDefaultSources(): SourcesConfig {
  return {
    sources: [DEFAULT_API_SOURCE],
  };
}

/**
 * Remove known-dead baked-in default sources (arc#267) from a loaded config,
 * matching on the exact name AND url so a user who repointed the name to a live
 * URL is left untouched. Returns true if the config was modified.
 */
export function pruneKnownDeadSources(config: SourcesConfig): boolean {
  const before = config.sources.length;
  config.sources = config.sources.filter(
    (s) => !KNOWN_DEAD_DEFAULT_SOURCES.some((d) => d.name === s.name && d.url === s.url),
  );
  return config.sources.length !== before;
}

export async function saveSources(
  sourcesPath: string,
  config: SourcesConfig
): Promise<void> {
  const content = YAML.stringify(config, { indent: 2 });
  await mkdir(dirname(sourcesPath), { recursive: true });
  await writeFile(sourcesPath, content, "utf-8");
}

/** Get effective source type (defaults to "registry" for backward compat) */
export function getSourceType(source: RegistrySource): SourceType {
  return source.type ?? "registry";
}

/** Validate source configuration based on its type */
export function validateSource(source: RegistrySource): { valid: boolean; error?: string } {
  const type = getSourceType(source);

  // Validate type value
  if (source.type && !VALID_SOURCE_TYPES.includes(source.type)) {
    return { valid: false, error: `Invalid source type "${source.type}". Valid types: ${VALID_SOURCE_TYPES.join(", ")}` };
  }

  if (type === "registry") {
    // Basic URL scheme validation (same as the old CLI check)
    if (!source.url.startsWith("https://") && !source.url.startsWith("http://") && !source.url.startsWith("file://")) {
      return { valid: false, error: `Invalid URL "${source.url}". Must start with https://, http://, or file://` };
    }
  }

  if (type === "metafactory") {
    // Must be HTTPS
    if (!source.url.startsWith("https://")) {
      return { valid: false, error: "metafactory sources require HTTPS URLs" };
    }
    // Must not be a YAML file path
    if (source.url.endsWith(".yaml") || source.url.endsWith(".yml")) {
      return { valid: false, error: "metafactory source URL should be a base URL, not a file path. Did you mean --type registry?" };
    }
  }

  return { valid: true };
}

export function addSource(
  config: SourcesConfig,
  source: RegistrySource
): void {
  const validation = validateSource(source);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const existing = config.sources.find((s) => s.name === source.name);
  if (existing) {
    throw new Error(`Source "${source.name}" already exists`);
  }
  config.sources.push(source);
}

export function removeSource(
  config: SourcesConfig,
  name: string
): void {
  const idx = config.sources.findIndex((s) => s.name === name);
  if (idx === -1) {
    throw new Error(`Source "${name}" not found`);
  }
  config.sources.splice(idx, 1);
}

/** Find a metafactory source by name or return the first one. */
export function findMetafactorySource(
  config: SourcesConfig,
  sourceName?: string,
): { source: RegistrySource } | { error: string } {
  if (sourceName) {
    const source = config.sources.find((s) => s.name === sourceName);
    if (!source) return { error: `Source "${sourceName}" not found` };
    if (getSourceType(source) !== "metafactory") {
      return { error: `Source "${source.name}" is type "${getSourceType(source)}", not "metafactory". Login is only for metafactory sources.` };
    }
    return { source };
  }

  const source = config.sources.find((s) => getSourceType(s) === "metafactory");
  if (!source) {
    return { error: "No metafactory source configured. Run: arc source add metafactory https://meta-factory.ai --type metafactory" };
  }
  return { source };
}

export function formatSourceList(config: SourcesConfig): string {
  if (!config.sources.length) return "No sources configured.";

  const lines: string[] = ["Configured sources:", ""];
  for (const s of config.sources) {
    const status = s.enabled ? "enabled" : "disabled";
    const type = getSourceType(s);
    lines.push(`  ${s.name} [${s.tier}] (${type}) (${status})`);
    lines.push(`    ${s.url}`);
  }
  return lines.join("\n");
}
