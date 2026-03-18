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
    return "No skills installed.";
  }

  const lines: string[] = [
    `Installed skills (${result.skills.length}):`,
    "",
  ];

  for (const s of result.skills) {
    const statusBadge = s.status === "active" ? "✅" : "⏸️";
    lines.push(
      `  ${statusBadge} ${s.name} v${s.version} [${s.status}]`
    );
  }

  return lines.join("\n");
}
