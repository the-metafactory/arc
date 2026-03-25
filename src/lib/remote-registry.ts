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
import { loadRegistry, searchRegistry } from "./registry.js";

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

export async function fetchRemoteRegistry(
  source: RegistrySource,
  cachePath: string
): Promise<RegistryConfig | null> {
  // Check cache first
  const cached = join(cachePath, cacheFileName(source));

  if (await isCacheFresh(cachePath, source)) {
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

export async function searchAllSources(
  sources: SourcesConfig,
  keyword: string,
  cachePath: string,
  localRegistryPath: string
): Promise<SourcedSearchResult[]> {
  const results: SourcedSearchResult[] = [];
  const enabledSources = sources.sources.filter((s) => s.enabled);
  let anyRemoteSucceeded = false;

  // Fetch from all enabled remote sources in parallel
  const fetches = enabledSources.map(async (source) => {
    const registry = await fetchRemoteRegistry(source, cachePath);
    if (!registry) return;

    anyRemoteSucceeded = true;
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

  // Fallback to local registry if all remotes failed
  if (!anyRemoteSucceeded) {
    const local = await loadRegistry(localRegistryPath);
    if (local) {
      const matches = searchRegistry(local, keyword);
      for (const m of matches) {
        results.push({
          entry: m.entry,
          artifactType: m.artifactType,
          sourceName: "local",
          sourceTier: "official" as PackageTier,
        });
      }
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
