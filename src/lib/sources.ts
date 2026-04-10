import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import YAML from "yaml";
import type { SourcesConfig, RegistrySource, SourceType } from "../types.js";

/** Valid source types */
export const VALID_SOURCE_TYPES: readonly SourceType[] = ["registry", "metafactory"];

const DEFAULT_SOURCE: RegistrySource = {
  name: "metafactory",
  url: "https://meta-factory.ai",
  type: "metafactory",
  tier: "official",
  enabled: true,
};

export async function loadSources(
  sourcesPath: string
): Promise<SourcesConfig> {
  if (!existsSync(sourcesPath)) {
    const config = createDefaultSources();
    await saveSources(sourcesPath, config);
    return config;
  }

  const content = await readFile(sourcesPath, "utf-8");
  const parsed = YAML.parse(content) as SourcesConfig;

  if (!parsed?.sources || !Array.isArray(parsed.sources)) {
    return createDefaultSources();
  }

  return parsed;
}

export function createDefaultSources(): SourcesConfig {
  return {
    sources: [DEFAULT_SOURCE],
  };
}

export async function saveSources(
  sourcesPath: string,
  config: SourcesConfig
): Promise<void> {
  const content = YAML.stringify(config, { indent: 2 });
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
  if (source.type && !VALID_SOURCE_TYPES.includes(source.type as SourceType)) {
    return { valid: false, error: `Invalid source type "${source.type}". Valid types: ${VALID_SOURCE_TYPES.join(", ")}` };
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
