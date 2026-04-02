import type { Database } from "bun:sqlite";
import { getSkill, getCapabilities, listByLibrary } from "../lib/db.js";
import { readManifest, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { findGitRoot } from "../lib/paths.js";
import type { InstalledSkill, ArcManifest } from "../types.js";

export interface InfoResult {
  skill: InstalledSkill | null;
  manifest: ArcManifest | null;
  releaseNotes: string | null;
  /** For library info: the artifacts installed from this library */
  libraryArtifacts?: InstalledSkill[];
  error?: string;
}

/**
 * Get detailed info about an installed skill or library.
 */
export async function info(
  db: Database,
  name: string
): Promise<InfoResult> {
  const skill = getSkill(db, name);

  if (!skill) {
    // Check if name matches a library (library itself isn't a DB entry, but its artifacts are)
    const libraryArtifacts = listByLibrary(db, name);
    if (libraryArtifacts.length > 0) {
      // Read the library root manifest from the git root of any artifact
      const gitRoot = findGitRoot(libraryArtifacts[0].install_path);
      const manifest = gitRoot ? await readManifest(gitRoot) : null;
      const releaseNotes = gitRoot ? await fetchReleaseNotesFromUrl(libraryArtifacts[0].repo_url, manifest?.version ?? libraryArtifacts[0].version) : null;
      return { skill: null, manifest, releaseNotes, libraryArtifacts };
    }
    return { skill: null, manifest: null, releaseNotes: null, error: `'${name}' is not installed` };
  }

  const manifest = await readManifest(skill.install_path);
  const releaseNotes = await fetchReleaseNotes(skill);

  return { skill, manifest, releaseNotes };
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

  // Library info — no skill entry, but has artifacts
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
 * Format library info from its artifacts.
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
