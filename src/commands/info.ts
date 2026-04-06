import { join } from "path";
import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import { getSkill, listByLibrary } from "../lib/db.js";
import { readManifest, readLibraryArtifacts, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { findGitRoot } from "../lib/paths.js";
import { extractRepoName } from "../lib/repo-name.js";
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
 * Get detailed info about a package (installed or from registry).
 * If not installed, attempts to resolve from configured sources.
 */
export async function info(
  db: Database,
  name: string,
  paths?: PaiPaths
): Promise<InfoResult> {
  const libRef = parseLibraryRef(name);
  const lookupName = libRef?.artifactName ? libRef.libraryName : name;
  const artifactFilter = libRef?.artifactName;

  // 1. Try installed packages
  const installed = await resolveInstalled(db, lookupName, artifactFilter);
  if (installed) return installed;

  // 2. Not installed — try registry
  if (!paths) {
    return errorResult(`'${name}' is not installed`);
  }

  return resolveRemote(name, lookupName, artifactFilter, paths);
}

/**
 * Look up a package from installed DB entries.
 * Returns null if not found in installed packages.
 */
async function resolveInstalled(
  db: Database,
  lookupName: string,
  artifactFilter: string | undefined
): Promise<InfoResult | null> {
  // Direct skill match
  const skill = getSkill(db, lookupName);
  if (skill && !artifactFilter) {
    const manifest = await readManifest(skill.install_path);
    const releaseNotes = await fetchReleaseNotesFromUrl(skill.repo_url, skill.version);
    return { skill, manifest, releaseNotes };
  }

  // Library artifact lookup (handles both "skill exists but filtering" and "no skill but library installed")
  if (artifactFilter) {
    return findInstalledLibraryArtifact(db, lookupName, artifactFilter);
  }

  // Whole library lookup (no artifact filter)
  const libraryArtifacts = listByLibrary(db, lookupName);
  if (libraryArtifacts.length > 0) {
    const gitRoot = findGitRoot(libraryArtifacts[0].install_path);
    const manifest = gitRoot ? await readManifest(gitRoot) : null;
    const releaseNotes = gitRoot
      ? await fetchReleaseNotesFromUrl(libraryArtifacts[0].repo_url, manifest?.version ?? libraryArtifacts[0].version)
      : null;
    return { skill: null, manifest, releaseNotes, libraryArtifacts };
  }

  // Not installed at all — also check for the standalone skill case when skill exists but artifactFilter wasn't set
  if (skill) {
    const manifest = await readManifest(skill.install_path);
    const releaseNotes = await fetchReleaseNotesFromUrl(skill.repo_url, skill.version);
    return { skill, manifest, releaseNotes };
  }

  return null;
}

/**
 * Find a specific artifact within an installed library.
 */
async function findInstalledLibraryArtifact(
  db: Database,
  libraryName: string,
  artifactName: string
): Promise<InfoResult | null> {
  const libraryArtifacts = listByLibrary(db, libraryName);
  if (libraryArtifacts.length === 0) return null;

  const match = libraryArtifacts.find((a) => a.name === artifactName);
  if (match) {
    const manifest = await readManifest(match.install_path);
    const releaseNotes = await fetchReleaseNotesFromUrl(match.repo_url, match.version);
    return { skill: match, manifest, releaseNotes };
  }

  return errorResult(`Artifact '${artifactName}' not found in library '${libraryName}'`);
}

/**
 * Resolve info for an uninstalled package via registry lookup and shallow clone.
 */
async function resolveRemote(
  originalName: string,
  lookupName: string,
  artifactFilter: string | undefined,
  paths: PaiPaths
): Promise<InfoResult> {
  const sources = await loadSources(paths.sourcesPath);
  const found = await findInAllSources(sources, lookupName, paths.cachePath);

  if (!found) {
    return errorResult(`'${originalName}' not found (not installed and not in any configured source)`);
  }

  const repoUrl = found.entry.source;
  const cacheCloneDir = join(paths.cachePath, "info", extractRepoName(repoUrl));

  const cloneError = cloneToCache(repoUrl, cacheCloneDir);
  if (cloneError) {
    return errorResult(`Failed to fetch package info: ${cloneError}`);
  }

  const manifest = await readManifest(cacheCloneDir);
  if (!manifest) {
    return errorResult(`'${lookupName}' has no arc-manifest.yaml`);
  }

  const remote = {
    sourceName: found.sourceName,
    sourceTier: found.sourceTier,
    repoUrl,
  };

  const releaseNotes = await fetchReleaseNotesFromUrl(repoUrl, manifest.version);

  if (manifest.type === "library" && artifactFilter) {
    return resolveRemoteLibraryArtifact(cacheCloneDir, manifest, lookupName, artifactFilter, remote);
  }

  return { skill: null, manifest, releaseNotes, remote };
}

/**
 * Find a specific artifact within a remote (uninstalled) library.
 */
async function resolveRemoteLibraryArtifact(
  cacheCloneDir: string,
  manifest: ArcManifest,
  libraryName: string,
  artifactName: string,
  remote: InfoResult["remote"]
): Promise<InfoResult> {
  const artifacts = await readLibraryArtifacts(cacheCloneDir, manifest);
  const match = artifacts.find((a) => a.manifest.name === artifactName);
  if (!match) {
    const available = artifacts.map((a) => a.manifest.name).join(", ");
    return errorResult(`Artifact '${artifactName}' not found in library '${libraryName}'. Available: ${available}`);
  }
  return { skill: null, manifest: match.manifest, releaseNotes: null, remote };
}

/**
 * Shallow-clone a repo to cache dir if not already present.
 * Returns an error string on failure, null on success.
 */
function cloneToCache(repoUrl: string, cacheCloneDir: string): string | null {
  if (existsSync(cacheCloneDir)) return null;

  const result = Bun.spawnSync(["git", "clone", "--depth", "1", repoUrl, cacheCloneDir], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    return result.stderr.toString().trim();
  }

  return null;
}

function errorResult(error: string): InfoResult {
  return { skill: null, manifest: null, releaseNotes: null, error };
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
  } catch (err: unknown) {
    // gh CLI not available or network timeout — release notes are non-critical
    const message = err instanceof Error ? err.message : String(err);
    console.debug(`Skipping release notes for ${nwo}@${tag}: ${message}`);
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
    return formatInstalledLibraryInfo(result);
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

  appendReleaseNotes(lines, result.releaseNotes);

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

  appendReleaseNotes(lines, result.releaseNotes);

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
      const displayName = a.path.split("/").pop() ?? a.path;
      lines.push(`    ${displayName}${desc}`);
    }
  }

  appendReleaseNotes(lines, result.releaseNotes);

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
 * Format installed library info from its artifacts.
 */
function formatInstalledLibraryInfo(result: InfoResult): string {
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

  appendReleaseNotes(lines, result.releaseNotes);

  return lines.join("\n");
}

/**
 * Append truncated release notes to output lines.
 */
function appendReleaseNotes(lines: string[], releaseNotes: string | null): void {
  if (!releaseNotes) return;

  const noteLines = releaseNotes.split("\n");
  lines.push("");
  lines.push("  Release Notes:");
  for (const line of noteLines.slice(0, 15)) {
    lines.push(`    ${line}`);
  }
  if (noteLines.length > 15) {
    lines.push("    ...(truncated)");
  }
}
