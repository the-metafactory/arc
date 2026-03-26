import { readFile } from "fs/promises";
import YAML from "yaml";
import type {
  RegistryConfig,
  RegistryEntry,
  ArtifactType,
  CatalogConfig,
  CatalogEntry,
} from "../types.js";
import { findEntry } from "./catalog.js";

/**
 * Load and parse registry.yaml from the given path.
 * Returns null if file doesn't exist.
 */
export async function loadRegistry(
  registryPath: string
): Promise<RegistryConfig | null> {
  try {
    const content = await readFile(registryPath, "utf-8");
    const parsed = YAML.parse(content) as RegistryConfig;

    if (!parsed.registry) {
      throw new Error("Invalid registry.yaml: missing 'registry' section");
    }

    parsed.registry.skills ??= [];
    parsed.registry.agents ??= [];
    parsed.registry.prompts ??= [];
    parsed.registry.tools ??= [];

    return parsed;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Search the registry by keyword (name or description, case-insensitive).
 */
export function searchRegistry(
  config: RegistryConfig,
  keyword: string
): Array<{ entry: RegistryEntry; artifactType: ArtifactType }> {
  const lower = keyword.toLowerCase();
  const results: Array<{ entry: RegistryEntry; artifactType: ArtifactType }> = [];

  const sections: Array<{ entries: RegistryEntry[]; type: ArtifactType }> = [
    { entries: config.registry.skills, type: "skill" },
    { entries: config.registry.agents, type: "agent" },
    { entries: config.registry.prompts, type: "prompt" },
    { entries: config.registry.tools, type: "tool" },
  ];

  for (const { entries, type } of sections) {
    for (const entry of entries) {
      if (
        entry.name.toLowerCase().includes(lower) ||
        entry.description.toLowerCase().includes(lower)
      ) {
        results.push({ entry, artifactType: type });
      }
    }
  }

  return results;
}

/**
 * Find a specific entry in the registry by exact name.
 */
export function findRegistryEntry(
  config: RegistryConfig,
  name: string
): { entry: RegistryEntry; artifactType: ArtifactType } | null {
  const lower = name.toLowerCase();
  for (const entry of config.registry.skills) {
    if (entry.name.toLowerCase() === lower) return { entry, artifactType: "skill" };
  }
  for (const entry of config.registry.agents) {
    if (entry.name.toLowerCase() === lower) return { entry, artifactType: "agent" };
  }
  for (const entry of config.registry.prompts) {
    if (entry.name.toLowerCase() === lower) return { entry, artifactType: "prompt" };
  }
  for (const entry of config.registry.tools) {
    if (entry.name.toLowerCase() === lower) return { entry, artifactType: "tool" };
  }
  return null;
}

/**
 * Copy an entry from the registry into a personal catalog.
 * Strips registry-specific fields (author, status, reviewed_by)
 * to produce a CatalogEntry.
 *
 * Returns the catalog entry and artifact type, or throws if not found
 * or already in catalog.
 */
export function addFromRegistry(
  registry: RegistryConfig,
  catalog: CatalogConfig,
  name: string
): { entry: CatalogEntry; artifactType: ArtifactType } {
  const found = findRegistryEntry(registry, name);
  if (!found) {
    throw new Error(`"${name}" not found in registry`);
  }

  const existing = findEntry(catalog, name);
  if (existing) {
    throw new Error(`"${name}" already exists in your catalog`);
  }

  // Strip registry-specific fields to create a CatalogEntry
  const catalogEntry: CatalogEntry = {
    name: found.entry.name,
    description: found.entry.description,
    source: found.entry.source,
    type: found.entry.type,
    ...(found.entry.has_cli ? { has_cli: true } : {}),
    ...(found.entry.bundle ? { bundle: true } : {}),
    ...(found.entry.requires?.length ? { requires: found.entry.requires } : {}),
  };

  const section =
    found.artifactType === "skill"
      ? catalog.catalog.skills
      : found.artifactType === "agent"
        ? catalog.catalog.agents
        : found.artifactType === "tool"
          ? catalog.catalog.tools
          : catalog.catalog.prompts;

  section.push(catalogEntry);

  return { entry: catalogEntry, artifactType: found.artifactType };
}

/**
 * Format registry search results for display.
 */
export function formatRegistrySearch(
  results: Array<{ entry: RegistryEntry; artifactType: ArtifactType }>
): string {
  if (!results.length) return "No matches found in registry.";

  const lines: string[] = [`Found ${results.length} match(es) in registry:`, ""];

  for (const { entry, artifactType } of results) {
    const statusBadge =
      entry.status === "shipped" ? "" :
      entry.status === "beta" ? " (beta)" :
      " (deprecated)";
    lines.push(
      `  ${entry.name} [${artifactType}]${statusBadge} — ${entry.description}`
    );
    lines.push(`    by ${entry.author} | source: ${entry.source}`);
    if (entry.reviewed_by?.length) {
      lines.push(`    reviewed by: ${entry.reviewed_by.join(", ")}`);
    }
  }

  return lines.join("\n");
}
