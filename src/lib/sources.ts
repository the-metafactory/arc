import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import YAML from "yaml";
import type { SourcesConfig, RegistrySource, PackageTier } from "../types.js";

const DEFAULT_SOURCE: RegistrySource = {
  name: "metafactory",
  url: "https://raw.githubusercontent.com/the-metafactory/meta-factory/main/REGISTRY.yaml",
  tier: "community",
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

export function addSource(
  config: SourcesConfig,
  source: RegistrySource
): void {
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
    lines.push(`  ${s.name} [${s.tier}] (${status})`);
    lines.push(`    ${s.url}`);
  }
  return lines.join("\n");
}
