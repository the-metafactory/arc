import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import YAML from "yaml";
import type { SourcesConfig, RegistrySource, SourceType } from "../types.js";

/** Valid source types */
export const VALID_SOURCE_TYPES: readonly SourceType[] = ["registry", "metafactory"];

// The metafactory API source -- the sole default. Discovery goes through
// meta-factory.ai via the metafactory-api client.
const DEFAULT_API_SOURCE: RegistrySource = {
  name: "metafactory",
  url: "https://meta-factory.ai",
  type: "metafactory",
  tier: "official",
  enabled: true,
};

// A dead default shipped by arc <= 0.33.0: a REGISTRY.yaml fallback pointing at
// the-metafactory/meta-factory, which is not publicly reachable (404 on both the
// raw URL and the repo). New installs no longer get it; loadSources() prunes it
// from pre-existing configs. See arc#267.
const DEAD_DEFAULT_REGISTRY_NAME = "metafactory-registry";
const DEAD_DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/the-metafactory/meta-factory/main/REGISTRY.yaml";

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
  // Self-heal: shed the dead metafactory-registry default (arc#267) from
  // pre-existing configs, persisting only when something actually changed.
  if (pruneDeadDefaultSources(config)) {
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
 * Remove the dead `metafactory-registry` default (arc#267) from a loaded config.
 * Matches on the exact shipped name AND url so user-defined registry sources --
 * even one a user named `metafactory-registry` -- are never touched.
 * Returns true if an entry was removed.
 */
export function pruneDeadDefaultSources(config: SourcesConfig): boolean {
  const before = config.sources.length;
  config.sources = config.sources.filter(
    (s) => !(s.name === DEAD_DEFAULT_REGISTRY_NAME && s.url === DEAD_DEFAULT_REGISTRY_URL),
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
