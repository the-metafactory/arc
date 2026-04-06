import { join } from "path";
import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import { getSkill, listByLibrary } from "../lib/db.js";
import { readManifest, readLibraryArtifacts, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { findGitRoot } from "../lib/paths.js";
import { parseLibraryRef } from "../lib/artifact-installer.js";
import { loadSources } from "../lib/sources.js";
import { findInAllSources } from "../lib/remote-registry.js";
import type { InstalledSkill, ArcManifest, PaiPaths } from "../types.js";

export interface InfoResult {
  skill: InstalledSkill | null;
  manifest: ArcManifest | null;
  releaseNotes: string | null;
  /** For library info: the artifacts installed from this library */
  libraryArtifacts?: InstalledSkill[];
  /** For remote (uninstalled) packages: source metadata */
  remote?: {
    sourceName: string;
    sourceTier: string;
    repoUrl: string;
  };
  error?: string;
}

/**
 * Get detailed info about an installed skill or library.
 * If not installed, attempts to resolve from registry and clone to cache for inspection.
 */
export async function info(
  db: Database,
  name: string,
  paths?: PaiPaths
): Promise<InfoResult> {
  // Parse library:artifact syntax
  const libRef = parseLibraryRef(name);
  const lookupName = libRef?.artifactName ? libRef.libraryName : name;
  const artifactFilter = libRef?.artifactName;

  // 1. Check installed packages first
  const skill = getSkill(db, lookupName);

  if (skill) {
    // If filtering by artifact name within an installed standalone package, that doesn't make sense
    if (artifactFilter) {
      // Check if lookupName is a library with this artifact installed
      const libraryArtifacts = listByLibrary(db, lookupName);
      if (libraryArtifacts.length > 0) {
        const match = libraryArtifacts.find((a) => a.name === artifactFilter);
        if (match) {
          const manifest = await readManifest(match.install_path);
          const releaseNotes = await fetchReleaseNotesFromUrl(match.repo_url, match.version);
          return { skill: match, manifest, releaseNotes };
        }
        return { skill: null, manifest: null, releaseNotes: null, error: `Artifact '${artifactFilter}' not found in library '${lookupName}'` };
      }
    }
    const manifest = await readManifest(skill.install_path);
    const releaseNotes = await fetchReleaseNotes(skill);
    return { skill, manifest, releaseNotes };
  }

  // Check if name matches an installed library
  if (!artifactFilter) {
    const libraryArtifacts = listByLibrary(db, lookupName);
    if (libraryArtifacts.length > 0) {
      const gitRoot = findGitRoot(libraryArtifacts[0].install_path);
      const manifest = gitRoot ? await readManifest(gitRoot) : null;
      const releaseNotes = gitRoot ? await fetchReleaseNotesFromUrl(libraryArtifacts[0].repo_url, manifest?.version ?? libraryArtifacts[0].version) : null;
      return { skill: null, manifest, releaseNotes, libraryArtifacts };
    }
  } else {
    // library:artifact — check if library is installed
    const libraryArtifacts = listByLibrary(db, lookupName);
    if (libraryArtifacts.length > 0) {
      const match = libraryArtifacts.find((a) => a.name === artifactFilter);
      if (match) {
        const manifest = await readManifest(match.install_path);
        const releaseNotes = await fetchReleaseNotesFromUrl(match.repo_url, match.version);
        return { skill: match, manifest, releaseNotes };
      }
      return { skill: null, manifest: null, releaseNotes: null, error: `Artifact '${artifactFilter}' not found in library '${lookupName}'` };
    }
  }

  // 2. Not installed — try to resolve from registry
  if (!paths) {
    return { skill: null, manifest: null, releaseNotes: null, error: `'${name}' is not installed` };
  }

  return resolveRemoteInfo(name, lookupName, artifactFilter, paths);
}

/**
 * Resolve info for an uninstalled package by looking it up in configured sources,
 * cloning to cache, and reading the manifest.
 */
async function resolveRemoteInfo(
  originalName: string,
  lookupName: string,
  artifactFilter: string | undefined,
  paths: PaiPaths
): Promise<InfoResult> {
  const sources = await loadSources(paths.sourcesPath);
  const found = await findInAllSources(sources, lookupName, paths.cachePath);

  if (!found) {
    return { skill: null, manifest: null, releaseNotes: null, error: `'${originalName}' not found (not installed and not in any configured source)` };
  }

  // Clone to cache dir (not repos dir — this is just for inspection)
  const repoUrl = found.entry.source;
  const repoName = extractRepoName(repoUrl);
  const cacheCloneDir = join(paths.cachePath, "info", repoName);

  if (!existsSync(cacheCloneDir)) {
    const cloneResult = Bun.spawnSync(["git", "clone", "--depth", "1", repoUrl, cacheCloneDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (cloneResult.exitCode !== 0) {
      return {
        skill: null,
        manifest: null,
        releaseNotes: null,
        error: `Failed to fetch package info: ${cloneResult.stderr.toString().trim()}`,
      };
    }
  }

  const manifest = await readManifest(cacheCloneDir);
  if (!manifest) {
    return { skill: null, manifest: null, releaseNotes: null, error: `'${lookupName}' has no arc-manifest.yaml` };
  }

  const remote = {
    sourceName: found.sourceName,
    sourceTier: found.sourceTier,
    repoUrl,
  };

  const releaseNotes = await fetchReleaseNotesFromUrl(repoUrl, manifest.version);

  // Library: if filtering by artifact, find the specific one
  if (manifest.type === "library" && artifactFilter) {
    try {
      const artifacts = await readLibraryArtifacts(cacheCloneDir, manifest);
      const match = artifacts.find((a) => a.manifest.name === artifactFilter);
      if (!match) {
        const available = artifacts.map((a) => a.manifest.name).join(", ");
        return { skill: null, manifest: null, releaseNotes: null, error: `Artifact '${artifactFilter}' not found in library '${lookupName}'. Available: ${available}` };
      }
      return { skill: null, manifest: match.manifest, releaseNotes: null, remote };
    } catch (err: any) {
      return { skill: null, manifest: null, releaseNotes: null, error: `Failed to read library artifacts: ${err.message}` };
    }
  }

  // Library: return full library info with artifacts read from manifest
  if (manifest.type === "library") {
    return { skill: null, manifest, releaseNotes, remote };
  }

  // Standalone package
  return { skill: null, manifest, releaseNotes, remote };
}

/**
 * Extract repo name from a URL for cache directory naming.
 */
function extractRepoName(url: string): string {
  return url.replace(/\.git$/, "").split("/").pop() ?? "unknown";
}

/**
 * Fetch release notes for the installed version.
 */
async function fetchReleaseNotes(skill: InstalledSkill): Promise<string | null> {
  return fetchReleaseNotesFromUrl(skill.repo_url, skill.version);
}

/**
 * Fetch release notes by repo URL and version tag.
 */
async function fetchReleaseNotesFromUrl(repoUrl: string, version: string): Promise<string | null> {
  const tag = `v${version}`;
  const ghMatch = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!ghMatch) return null;

  const nwo = `${ghMatch[1]}/${ghMatch[2]}`;

  try {
    const result = Bun.spawnSync(
      ["gh", "release", "view", tag, "--repo", nwo, "--json", "body", "--jq", ".body"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 }
    );
    if (result.exitCode === 0) {
      const body = result.stdout.toString().trim();
      if (body) return body;
    }
  } catch {
    // gh not available or network issue — skip
  }

  return null;
}

/**
 * Format info for console display.
 */
export function formatInfo(result: InfoResult): string {
  if (result.error) return `Error: ${result.error}`;

  // Remote library (uninstalled)
  if (result.remote && result.manifest?.type === "library") {
    return formatRemoteLibraryInfo(result);
  }

  // Remote standalone (uninstalled)
  if (result.remote && result.manifest) {
    return formatRemoteInfo(result);
  }

  // Installed library — no skill entry, but has artifacts
  if (!result.skill && result.libraryArtifacts?.length) {
    return formatLibraryInfo(result);
  }

  const { skill, manifest } = result;
  if (!skill) return "Package not found.";

  const lines: string[] = [
    `${skill.name} v${skill.version}`,
    `  Status: ${skill.status}`,
    `  Tier: ${skill.tier || "custom"}`,
    `  Source: ${skill.install_source || "direct"}`,
    `  Repo: ${skill.repo_url}`,
    `  Path: ${skill.install_path}`,
    `  Installed: ${skill.installed_at}`,
  ];

  if (skill.customization_path) {
    lines.push(`  Customizations: ${skill.customization_path}`);
  }

  if (manifest) {
    const risk = assessRisk(manifest);
    lines.push(`  Risk: ${risk.toUpperCase()}`);
    const author = manifest.author ?? manifest.authors?.[0];
    if (author) {
      lines.push(`  Author: ${author.name} (${author.github})`);
    }
    lines.push(`  Capabilities:`);
    lines.push(...formatCapabilities(manifest));

    if (manifest.provides?.skill?.length) {
      lines.push(`  Triggers:`);
      for (const t of manifest.provides.skill) {
        lines.push(`    - "${t.trigger}"`);
      }
    }
  }

  if (result.releaseNotes) {
    lines.push("");
    lines.push("  Release Notes:");
    for (const line of result.releaseNotes.split("\n").slice(0, 15)) {
      lines.push(`    ${line}`);
    }
    if (result.releaseNotes.split("\n").length > 15) {
      lines.push("    ...(truncated)");
    }
  }

  return lines.join("\n");
}

/**
 * Format remote (uninstalled) standalone package info.
 */
function formatRemoteInfo(result: InfoResult): string {
  const { manifest, remote } = result;
  if (!manifest || !remote) return "Package not found.";

  const lines: string[] = [];
  const typeLabel = manifest.type ?? "skill";

  lines.push(`📦 ${manifest.name} v${manifest.version} (${typeLabel})`);

  const author = manifest.author ?? manifest.authors?.[0];
  if (author) {
    lines.push(`  Author: ${author.name} (${author.github})`);
  }
  lines.push(`  Source: ${remote.sourceTier} [${remote.sourceName}]`);

  const risk = assessRisk(manifest);
  lines.push(`  Risk: ${risk.toUpperCase()}`);

  if (manifest.capabilities) {
    lines.push(`  Capabilities:`);
    lines.push(...formatCapabilities(manifest));
  }

  if (manifest.provides?.skill?.length) {
    lines.push(`  Triggers:`);
    for (const t of manifest.provides.skill) {
      lines.push(`    - "${t.trigger}"`);
    }
  }

  if (result.releaseNotes) {
    lines.push("");
    lines.push("  Release Notes:");
    for (const line of result.releaseNotes.split("\n").slice(0, 15)) {
      lines.push(`    ${line}`);
    }
    if (result.releaseNotes.split("\n").length > 15) {
      lines.push("    ...(truncated)");
    }
  }

  lines.push("");
  lines.push(`  Install: arc install ${manifest.name}`);

  return lines.join("\n");
}

/**
 * Format remote (uninstalled) library info with artifacts from manifest.
 */
function formatRemoteLibraryInfo(result: InfoResult): string {
  const { manifest, remote } = result;
  if (!manifest || !remote) return "Package not found.";

  const lines: string[] = [];

  lines.push(`📚 ${manifest.name} v${manifest.version} (library)`);

  const author = manifest.author ?? manifest.authors?.[0];
  if (author) {
    lines.push(`  Author: ${author.name} (${author.github})`);
  }
  lines.push(`  Source: ${remote.sourceTier} [${remote.sourceName}]`);

  if (manifest.artifacts?.length) {
    lines.push("");
    lines.push(`  Artifacts (${manifest.artifacts.length}):`);
    for (const a of manifest.artifacts) {
      const desc = a.description ? ` — ${a.description}` : "";
      // Use the path's last segment as a display name if no description
      const displayName = a.path.split("/").pop() ?? a.path;
      lines.push(`    ${displayName}${desc}`);
    }
  }

  if (result.releaseNotes) {
    lines.push("");
    lines.push("  Release Notes:");
    for (const line of result.releaseNotes.split("\n").slice(0, 15)) {
      lines.push(`    ${line}`);
    }
    if (result.releaseNotes.split("\n").length > 15) {
      lines.push("    ...(truncated)");
    }
  }

  lines.push("");
  lines.push(`  Install all:  arc install ${manifest.name}`);
  lines.push(`  Install one:  arc install ${manifest.name}:<artifact-name>`);

  return lines.join("\n");
}

/**
 * Format info as JSON.
 */
export function formatInfoJson(result: InfoResult): string {
  if (result.error) {
    return JSON.stringify({ error: result.error }, null, 2);
  }

  const json: Record<string, unknown> = {};

  if (result.manifest) {
    json.name = result.manifest.name;
    json.version = result.manifest.version;
    json.type = result.manifest.type;

    const author = result.manifest.author ?? result.manifest.authors?.[0];
    if (author) json.author = author;

    if (result.manifest.capabilities) {
      json.capabilities = result.manifest.capabilities;
      json.risk = assessRisk(result.manifest);
    }

    if (result.manifest.artifacts) {
      json.artifacts = result.manifest.artifacts;
    }
  }

  if (result.skill) {
    json.installed = true;
    json.status = result.skill.status;
    json.tier = result.skill.tier;
    json.install_source = result.skill.install_source;
    json.repo_url = result.skill.repo_url;
    json.install_path = result.skill.install_path;
    json.installed_at = result.skill.installed_at;
  } else {
    json.installed = false;
  }

  if (result.remote) {
    json.source = result.remote.sourceName;
    json.source_tier = result.remote.sourceTier;
    json.repo_url = result.remote.repoUrl;
  }

  if (result.libraryArtifacts?.length) {
    json.installed_artifacts = result.libraryArtifacts.map((a) => ({
      name: a.name,
      version: a.version,
      type: a.artifact_type,
      status: a.status,
    }));
  }

  if (result.releaseNotes) {
    json.release_notes = result.releaseNotes;
  }

  return JSON.stringify(json, null, 2);
}

/**
 * Format library info from its installed artifacts.
 */
function formatLibraryInfo(result: InfoResult): string {
  const { manifest, libraryArtifacts } = result;
  const artifacts = libraryArtifacts ?? [];

  const name = manifest?.name ?? artifacts[0]?.library_name ?? "unknown";
  const version = manifest?.version ?? artifacts[0]?.version ?? "?";
  const lines: string[] = [];

  lines.push(`\u{1F4DA} ${name} v${version} (library)`);

  if (manifest) {
    const author = manifest.author ?? manifest.authors?.[0];
    if (author) {
      lines.push(`  Author: ${author.name} (${author.github})`);
    }
  }

  lines.push(`  Repo: ${artifacts[0]?.repo_url ?? "unknown"}`);
  lines.push(`  Installed artifacts: ${artifacts.length}`);

  // Group by type
  const byType = new Map<string, InstalledSkill[]>();
  for (const a of artifacts) {
    const type = a.artifact_type;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(a);
  }

  lines.push("");
  for (const [type, items] of byType) {
    lines.push(`  ${type}s (${items.length}):`);
    for (const item of items) {
      const statusBadge = item.status === "active" ? "\u2705" : "\u23F8\uFE0F";
      lines.push(`    ${statusBadge} ${item.name} v${item.version}`);
    }
  }

  if (result.releaseNotes) {
    lines.push("");
    lines.push("  Release Notes:");
    for (const line of result.releaseNotes.split("\n").slice(0, 15)) {
      lines.push(`    ${line}`);
    }
    if (result.releaseNotes.split("\n").length > 15) {
      lines.push("    ...(truncated)");
    }
  }

  return lines.join("\n");
}
