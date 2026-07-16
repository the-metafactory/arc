import { readFile } from "fs/promises";
import YAML from "yaml";
import type {
  RegistryConfig,
  RegistryEntry,
  ArtifactType,
} from "../types.js";
import { isErrno } from "./errors.js";

/**
 * Load and parse registry.yaml from the given path.
 * Returns null if file doesn't exist.
 */
export async function loadRegistry(
  registryPath: string
): Promise<RegistryConfig | null> {
  try {
    const content = await readFile(registryPath, "utf-8");
    const raw = YAML.parse(content) as Partial<RegistryConfig> | null;

    if (!raw?.registry) {
      throw new Error("Invalid registry.yaml: missing 'registry' section");
    }

    const reg = raw.registry as Partial<RegistryConfig["registry"]>;
    reg.skills ??= [];
    reg.agents ??= [];
    reg.prompts ??= [];
    reg.tools ??= [];
    reg.components ??= [];
    reg.rules ??= [];

    return raw as RegistryConfig;
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Search the registry by keyword (name or description, case-insensitive).
 */
export function searchRegistry(
  config: RegistryConfig,
  keyword: string
): { entry: RegistryEntry; artifactType: ArtifactType }[] {
  const lower = keyword.toLowerCase();
  const results: { entry: RegistryEntry; artifactType: ArtifactType }[] = [];

  const sections: { entries: RegistryEntry[]; type: ArtifactType }[] = [
    { entries: config.registry.skills, type: "skill" },
    { entries: config.registry.agents, type: "agent" },
    { entries: config.registry.prompts, type: "prompt" },
    { entries: config.registry.tools, type: "tool" },
    { entries: config.registry.components ?? [], type: "component" },
    { entries: config.registry.rules ?? [], type: "rules" },
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
  for (const entry of config.registry.components ?? []) {
    if (entry.name.toLowerCase() === lower) return { entry, artifactType: "component" };
  }
  for (const entry of config.registry.rules ?? []) {
    if (entry.name.toLowerCase() === lower) return { entry, artifactType: "rules" };
  }
  return null;
}

/**
 * Format registry search results for display.
 */
export function formatRegistrySearch(
  results: { entry: RegistryEntry; artifactType: ArtifactType }[]
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
