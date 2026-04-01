import type { Database } from "bun:sqlite";
import { listSkills } from "../lib/db.js";
import type { InstalledSkill } from "../types.js";

export interface ListResult {
  skills: InstalledSkill[];
}

/**
 * List all installed skills with version and status.
 */
export function list(db: Database): ListResult {
  const skills = listSkills(db);
  return { skills };
}

/**
 * Format the list for console display.
 */
export function formatList(result: ListResult): string {
  if (result.skills.length === 0) {
    return "No packages installed.";
  }

  const skills = result.skills.filter((s) => !["tool", "pipeline"].includes(s.artifact_type));
  const tools = result.skills.filter((s) => s.artifact_type === "tool");
  const pipelines = result.skills.filter((s) => s.artifact_type === "pipeline");
  const lines: string[] = [];
  let sectionCount = 0;

  if (skills.length > 0) {
    lines.push(`Installed skills (${skills.length}):`, "");
    for (const s of skills) {
      const statusBadge = s.status === "active" ? "✅" : "⏸️";
      const tierBadge = s.tier === "official" ? " (official)" : s.tier === "community" ? " (community)" : "";
      const customBadge = s.customization_path ? " *" : "";
      lines.push(`  ${statusBadge} ${s.name} v${s.version} [${s.status}]${tierBadge}${customBadge}`);
    }
    sectionCount++;
  }

  if (tools.length > 0) {
    if (sectionCount > 0) lines.push("");
    lines.push(`Installed tools (${tools.length}):`, "");
    for (const t of tools) {
      const statusBadge = t.status === "active" ? "✅" : "⏸️";
      const tierBadge = t.tier === "official" ? " (official)" : t.tier === "community" ? " (community)" : "";
      lines.push(`  ${statusBadge} ${t.name} v${t.version} [${t.status}]${tierBadge}`);
    }
    sectionCount++;
  }

  if (pipelines.length > 0) {
    if (sectionCount > 0) lines.push("");
    lines.push(`Installed pipelines (${pipelines.length}):`, "");
    for (const p of pipelines) {
      const statusBadge = p.status === "active" ? "✅" : "⏸️";
      const tierBadge = p.tier === "official" ? " (official)" : p.tier === "community" ? " (community)" : "";
      lines.push(`  ${statusBadge} ${p.name} v${p.version} [${p.status}]${tierBadge}`);
    }
  }

  if (result.skills.some((s) => s.customization_path)) {
    lines.push("", "  * = has local customizations");
  }

  return lines.join("\n");
}
