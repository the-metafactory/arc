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
  // metafactory API sources use the dedicated API client
  if (source.type === "metafactory") {
    const { fetchMetafactoryRegistry } = await import("./metafactory-api.js");
    return fetchMetafactoryRegistry(source, cachePath, forceRefresh);
  }

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
    const headers: Record<string, string> = {};

    // raw.githubusercontent.com does NOT honor Authorization headers for
    // private repos — only browser session cookies. For private repos we
    // have to go through the Contents API, which respects PAT auth.
    // Rewrite raw URLs transparently so existing sources.yaml entries
    // keep working unchanged.
    let fetchUrl = source.url;
    const rewritten = rewriteRawToContentsApi(source.url);
    if (rewritten) {
      fetchUrl = rewritten;
      headers["Accept"] = "application/vnd.github.raw";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    }

    // Add GitHub token for private repos accessed via raw.githubusercontent.com or api.github.com
    if (fetchUrl.includes("github")) {
      const token = process.env.GITHUB_TOKEN ?? getGhToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    const response = await fetch(fetchUrl, {
      signal: AbortSignal.timeout(10_000),
      headers,
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

/**
 * Rewrite a raw.githubusercontent.com URL to the equivalent GitHub
 * Contents API URL. Returns null if the URL doesn't match the raw
 * pattern (in which case the caller should fetch the original URL
 * unchanged).
 *
 * Input:  https://raw.githubusercontent.com/OWNER/REPO/REF/PATH/TO/FILE
 * Output: https://api.github.com/repos/OWNER/REPO/contents/PATH/TO/FILE?ref=REF
 *
 * The Contents API honors PAT authentication for private repos, which
 * raw.githubusercontent.com does not. With Accept: application/vnd.github.raw
 * the response body is the raw file content (same shape as the raw URL).
 */
export function rewriteRawToContentsApi(url: string): string | null {
  const match = url.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (!match) return null;
  const [, owner, repo, ref, path] = match;
  return `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref!)}`;
}

/** Try to get GitHub token from gh CLI auth */
function getGhToken(): string | null {
  try {
    const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
  } catch {
    // gh not installed or not authenticated
  }
  return null;
}
