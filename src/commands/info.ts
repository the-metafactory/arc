import type { Database } from "bun:sqlite";
import { getSkill, getCapabilities } from "../lib/db.js";
import { readManifest, assessRisk, formatCapabilities } from "../lib/manifest.js";
import type { InstalledSkill, ArcManifest } from "../types.js";

export interface InfoResult {
  skill: InstalledSkill | null;
  manifest: ArcManifest | null;
  releaseNotes: string | null;
  error?: string;
}

/**
 * Get detailed info about an installed skill.
 */
export async function info(
  db: Database,
  name: string
): Promise<InfoResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { skill: null, manifest: null, releaseNotes: null, error: `Skill '${name}' is not installed` };
  }

  const manifest = await readManifest(skill.install_path);
  const releaseNotes = await fetchReleaseNotes(skill);

  return { skill, manifest, releaseNotes };
}

/**
 * Fetch release notes for the installed version.
 * Tries: gh release view from the source repo.
 */
async function fetchReleaseNotes(skill: InstalledSkill): Promise<string | null> {
  const tag = `v${skill.version}`;

  // Extract owner/repo from repo_url for gh CLI
  const ghMatch = skill.repo_url.match(
    /github\.com[:/]([^/]+)\/([^/.]+)/
  );
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

  const { skill, manifest } = result;
  if (!skill) return "Skill not found.";

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
