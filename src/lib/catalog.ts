import { readFile, writeFile } from "fs/promises";
import YAML from "yaml";
import type {
  CatalogConfig,
  CatalogEntry,
  ArtifactType,
} from "../types.js";
import { getSkill } from "./db.js";
import { parseDependencyRef } from "./source-resolver.js";
import type { Database } from "bun:sqlite";

/**
 * Load and parse catalog.yaml from the given path.
 * Returns null if file doesn't exist.
 */
export async function loadCatalog(
  catalogPath: string
): Promise<CatalogConfig | null> {
  try {
    const content = await readFile(catalogPath, "utf-8");
    const parsed = YAML.parse(content) as CatalogConfig;

    if (!parsed.defaults || !parsed.catalog) {
      throw new Error(
        "Invalid catalog.yaml: missing required sections (defaults, catalog)"
      );
    }

    // Ensure arrays exist even if empty in YAML
    parsed.catalog.skills ??= [];
    parsed.catalog.agents ??= [];
    parsed.catalog.prompts ??= [];

    return parsed;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write catalog config back to YAML file.
 */
export async function saveCatalog(
  catalogPath: string,
  config: CatalogConfig
): Promise<void> {
  const content = YAML.stringify(config, {
    lineWidth: 120,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
  });
  await writeFile(catalogPath, content, "utf-8");
}

/**
 * Find a catalog entry by name, searching across all artifact types.
 * Returns the entry and which section it was found in.
 */
export function findEntry(
  config: CatalogConfig,
  name: string
): { entry: CatalogEntry; artifactType: ArtifactType } | null {
  for (const entry of config.catalog.skills) {
    if (entry.name === name) return { entry, artifactType: "skill" };
  }
  for (const entry of config.catalog.agents) {
    if (entry.name === name) return { entry, artifactType: "agent" };
  }
  for (const entry of config.catalog.prompts) {
    if (entry.name === name) return { entry, artifactType: "prompt" };
  }
  return null;
}

/**
 * Search catalog entries by keyword (matches name or description, case-insensitive).
 */
export function searchCatalog(
  config: CatalogConfig,
  keyword: string
): Array<{ entry: CatalogEntry; artifactType: ArtifactType }> {
  const lower = keyword.toLowerCase();
  const results: Array<{ entry: CatalogEntry; artifactType: ArtifactType }> = [];

  const sections: Array<{ entries: CatalogEntry[]; type: ArtifactType }> = [
    { entries: config.catalog.skills, type: "skill" },
    { entries: config.catalog.agents, type: "agent" },
    { entries: config.catalog.prompts, type: "prompt" },
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

/** Catalog listing with install status per entry */
export interface CatalogListItem {
  entry: CatalogEntry;
  artifactType: ArtifactType;
  installed: boolean;
  status?: "active" | "disabled";
}

/**
 * List all catalog entries with their install status (checked against DB).
 */
export function listCatalog(
  config: CatalogConfig,
  db: Database
): CatalogListItem[] {
  const items: CatalogListItem[] = [];

  const sections: Array<{ entries: CatalogEntry[]; type: ArtifactType }> = [
    { entries: config.catalog.skills, type: "skill" },
    { entries: config.catalog.agents, type: "agent" },
    { entries: config.catalog.prompts, type: "prompt" },
  ];

  for (const { entries, type } of sections) {
    for (const entry of entries) {
      const skill = getSkill(db, entry.name);
      items.push({
        entry,
        artifactType: type,
        installed: skill !== null,
        status: skill?.status,
      });
    }
  }

  return items;
}

/**
 * Add an entry to the catalog. Throws if an entry with that name already exists.
 */
export function addEntry(
  config: CatalogConfig,
  entry: CatalogEntry,
  artifactType: ArtifactType
): void {
  const existing = findEntry(config, entry.name);
  if (existing) {
    throw new Error(
      `Entry "${entry.name}" already exists in catalog as ${existing.artifactType}`
    );
  }

  const section =
    artifactType === "skill"
      ? config.catalog.skills
      : artifactType === "agent"
        ? config.catalog.agents
        : config.catalog.prompts;

  section.push(entry);
}

/**
 * Remove an entry from the catalog by name. Returns true if found and removed.
 */
export function removeEntry(
  config: CatalogConfig,
  name: string
): boolean {
  for (const section of [
    config.catalog.skills,
    config.catalog.agents,
    config.catalog.prompts,
  ]) {
    const idx = section.findIndex((e) => e.name === name);
    if (idx !== -1) {
      section.splice(idx, 1);
      return true;
    }
  }
  return false;
}

/**
 * Resolve dependency tree for a catalog entry.
 * Returns entries in install order (dependencies first).
 * Detects circular dependencies.
 */
export function resolveDependencies(
  config: CatalogConfig,
  entryName: string,
  visited: Set<string> = new Set()
): Array<{ entry: CatalogEntry; artifactType: ArtifactType }> {
  if (visited.has(entryName)) {
    throw new Error(`Circular dependency detected: ${entryName}`);
  }
  visited.add(entryName);

  const found = findEntry(config, entryName);
  if (!found) {
    throw new Error(`Entry "${entryName}" not found in catalog`);
  }

  const result: Array<{ entry: CatalogEntry; artifactType: ArtifactType }> = [];

  if (found.entry.requires?.length) {
    for (const ref of found.entry.requires) {
      const { name } = parseDependencyRef(ref);
      const deps = resolveDependencies(config, name, new Set(visited));
      for (const dep of deps) {
        if (!result.some((r) => r.entry.name === dep.entry.name)) {
          result.push(dep);
        }
      }
    }
  }

  if (!result.some((r) => r.entry.name === found.entry.name)) {
    result.push(found);
  }

  return result;
}
