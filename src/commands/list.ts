import type { Database } from "bun:sqlite";
import { listSkills, listByLibrary } from "../lib/db.js";
import type { ArtifactType, InstalledSkill } from "../types.js";

export interface ListResult {
  skills: InstalledSkill[];
}

export interface ListOptions {
  /** Filter by artifact type */
  type?: ArtifactType;
  /** Filter by library name */
  library?: string;
}

/**
 * List all installed skills with version and status.
 */
export function list(db: Database, opts?: ListOptions): ListResult {
  let skills: InstalledSkill[];
  if (opts?.library) {
    skills = listByLibrary(db, opts.library);
  } else {
    skills = listSkills(db);
  }
  if (opts?.type) {
    skills = skills.filter((s) => s.artifact_type === opts.type);
  }
  return { skills };
}

/**
 * Format installed packages as JSON for machine consumption.
 */
export function formatListJson(result: ListResult): string {
  const packages = result.skills.map((s) => ({
    name: s.name,
    version: s.version,
    type: s.artifact_type,
    status: s.status,
    tier: s.tier,
    repoUrl: s.repo_url,
    installPath: s.install_path,
    ...(s.library_name ? { library: s.library_name } : {}),
  }));
  return JSON.stringify({ packages }, null, 2);
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
      const libraryBadge = s.library_name ? ` 📚${s.library_name}` : "";
      lines.push(`  ${statusBadge} ${s.name} v${s.version} [${s.status}]${tierBadge}${customBadge}${libraryBadge}`);
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
