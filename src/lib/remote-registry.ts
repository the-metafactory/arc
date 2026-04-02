import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type {
  RegistryConfig,
  RegistrySource,
  SourcesConfig,
  SourcedSearchResult,
  ArtifactType,
  RegistryEntry,
  PackageTier,
} from "../types.js";
import { loadRegistry, searchRegistry, findRegistryEntry } from "./registry.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheFileName(source: RegistrySource): string {
  return `${source.name}.yaml`;
}

async function isCacheFresh(
  cachePath: string,
  source: RegistrySource
): Promise<boolean> {
  const filePath = join(cachePath, cacheFileName(source));
  if (!existsSync(filePath)) return false;

  try {
    const st = await stat(filePath);
    return Date.now() - st.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Fetch a registry from a source URL.
 * Supports https:// (remote) and file:// (local private registries).
 * Caches remote results for CACHE_TTL_MS. Local files are always read fresh.
 */
export async function fetchRemoteRegistry(
  source: RegistrySource,
  cachePath: string,
  forceRefresh?: boolean
): Promise<RegistryConfig | null> {
  // Local file source — read directly, no caching
  if (source.url.startsWith("file://")) {
    const filePath = source.url.replace("file://", "");
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = YAML.parse(content) as RegistryConfig;
      if (!parsed?.registry) return null;
      parsed.registry.skills ??= [];
      parsed.registry.agents ??= [];
      parsed.registry.prompts ??= [];
      parsed.registry.tools ??= [];
      parsed.registry.components ??= [];
      parsed.registry.rules ??= [];
      return parsed;
    } catch {
      return null;
    }
  }

  // Remote source — check cache first
  const cached = join(cachePath, cacheFileName(source));

  if (!forceRefresh && (await isCacheFresh(cachePath, source))) {
    try {
      const content = await readFile(cached, "utf-8");
      const parsed = YAML.parse(content) as RegistryConfig;
      if (parsed?.registry) return parsed;
    } catch {
      // Cache corrupt, fetch fresh
    }
  }

  // Fetch from remote
  try {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const text = await response.text();
    const parsed = YAML.parse(text) as RegistryConfig;

    if (!parsed?.registry) return null;

    parsed.registry.skills ??= [];
    parsed.registry.agents ??= [];
    parsed.registry.prompts ??= [];
    parsed.registry.tools ??= [];
    parsed.registry.components ??= [];

    // Cache the result
    if (!existsSync(cachePath)) {
      await mkdir(cachePath, { recursive: true });
    }
    await writeFile(cached, text, "utf-8");

    return parsed;
  } catch {
    // Network failure — try stale cache
    if (existsSync(cached)) {
      try {
        const content = await readFile(cached, "utf-8");
        const parsed = YAML.parse(content) as RegistryConfig;
        if (parsed?.registry) return parsed;
      } catch {
        // Nothing we can do
      }
    }
    return null;
  }
}

/**
 * Search across all enabled sources (like `apt-cache search`).
 */
export async function searchAllSources(
  sources: SourcesConfig,
  keyword: string,
  cachePath: string
): Promise<SourcedSearchResult[]> {
  const results: SourcedSearchResult[] = [];
  const enabledSources = sources.sources.filter((s) => s.enabled);

  const fetches = enabledSources.map(async (source) => {
    const registry = await fetchRemoteRegistry(source, cachePath);
    if (!registry) return;

    const matches = searchRegistry(registry, keyword);
    for (const m of matches) {
      results.push({
        entry: m.entry,
        artifactType: m.artifactType,
        sourceName: source.name,
        sourceTier: source.tier,
      });
    }
  });

  await Promise.all(fetches);
  return results;
}

/**
 * Find a specific package by exact name across all sources (like `apt-cache show`).
 */
export async function findInAllSources(
  sources: SourcesConfig,
  name: string,
  cachePath: string
): Promise<SourcedSearchResult | null> {
  const enabledSources = sources.sources.filter((s) => s.enabled);

  const fetches = enabledSources.map(async (source) => {
    const registry = await fetchRemoteRegistry(source, cachePath);
    if (!registry) return null;

    const found = findRegistryEntry(registry, name);
    if (!found) return null;

    return {
      entry: found.entry,
      artifactType: found.artifactType,
      sourceName: source.name,
      sourceTier: source.tier,
    } as SourcedSearchResult;
  });

  const results = await Promise.all(fetches);
  return results.find((r) => r !== null) ?? null;
}

/**
 * Force-refresh all source caches (like `apt update`).
 */
export async function updateAllSources(
  sources: SourcesConfig,
  cachePath: string
): Promise<Array<{ name: string; status: "ok" | "failed"; count?: number }>> {
  const enabledSources = sources.sources.filter((s) => s.enabled);
  const results: Array<{ name: string; status: "ok" | "failed"; count?: number }> = [];

  for (const source of enabledSources) {
    const registry = await fetchRemoteRegistry(source, cachePath, true);
    if (registry) {
      const count =
        registry.registry.skills.length +
        registry.registry.agents.length +
        registry.registry.prompts.length +
        registry.registry.tools.length +
        (registry.registry.components?.length ?? 0) +
        (registry.registry.rules?.length ?? 0);
      results.push({ name: source.name, status: "ok", count });
    } else {
      results.push({ name: source.name, status: "failed" });
    }
  }

  return results;
}

export function formatSourcedSearch(results: SourcedSearchResult[]): string {
  if (!results.length) return "No matches found across any source.";

  const lines: string[] = [
    `Found ${results.length} match(es) across sources:`,
    "",
  ];

  for (const r of results) {
    const statusBadge =
      r.entry.status === "shipped"
        ? ""
        : r.entry.status === "beta"
          ? " (beta)"
          : " (deprecated)";
    const tierBadge = `[${r.sourceTier}]`;

    lines.push(
      `  ${r.entry.name} [${r.artifactType}]${statusBadge} ${tierBadge} — ${r.entry.description}`
    );
    lines.push(`    by ${r.entry.author} | source: ${r.sourceName}`);
    if (r.entry.reviewed_by?.length) {
      lines.push(`    reviewed by: ${r.entry.reviewed_by.join(", ")}`);
    }
  }

  return lines.join("\n");
}
