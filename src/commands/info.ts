import type { Database } from "bun:sqlite";
import { getSkill, getCapabilities } from "../lib/db.js";
import { readManifest, assessRisk, formatCapabilities } from "../lib/manifest.js";
import type { InstalledSkill, PaiManifest } from "../types.js";

export interface InfoResult {
  skill: InstalledSkill | null;
  manifest: PaiManifest | null;
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
    return { skill: null, manifest: null, error: `Skill '${name}' is not installed` };
  }

  const manifest = await readManifest(skill.install_path);

  return { skill, manifest };
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
    lines.push(`  Author: ${manifest.author.name} (${manifest.author.github})`);
    lines.push(`  Capabilities:`);
    lines.push(...formatCapabilities(manifest));

    if (manifest.provides?.skill?.length) {
      lines.push(`  Triggers:`);
      for (const t of manifest.provides.skill) {
        lines.push(`    - "${t.trigger}"`);
      }
    }
  }

  return lines.join("\n");
}
