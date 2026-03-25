import { join } from "path";
import { rm } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, removeSkill } from "../lib/db.js";
import { removeSymlink, removeCliShim } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";

export interface RemoveResult {
  success: boolean;
  name?: string;
  error?: string;
}

/**
 * Completely remove an installed skill.
 * Removes symlinks, repo directory, and database entry.
 */
export async function remove(
  db: Database,
  paths: PaiPaths,
  name: string
): Promise<RemoveResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, error: `Skill '${name}' is not installed` };
  }

  const isTool = skill.artifact_type === "tool";
  const isAgent = skill.artifact_type === "agent";
  const isPrompt = skill.artifact_type === "prompt";

  if (isTool) {
    // Tools: remove bin symlink (repo root linked to binDir)
    const binLink = join(paths.binDir, name);
    await removeSymlink(binLink);
  } else if (isAgent) {
    // Agents: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(paths.agentsDir, `${name}.md`);
    const dirLink = join(paths.agentsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else if (isPrompt) {
    // Prompts: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(paths.promptsDir, `${name}.md`);
    const dirLink = join(paths.promptsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else {
    // Skills: remove skill symlink
    const skillLink = join(paths.skillsDir, name);
    await removeSymlink(skillLink);

    // Remove bin symlink (skills with CLI)
    const binName = name.replace(/^_/, "").toLowerCase();
    const binLink = join(paths.binDir, binName);
    await removeSymlink(binLink);
  }

  // Remove CLI shim from PATH (only for skills and tools)
  if (!isAgent && !isPrompt) {
    const shimName = isTool
      ? (await readManifest(skill.install_path))?.provides?.cli?.[0]?.name ?? name.toLowerCase()
      : name.replace(/^_/, "").toLowerCase();
    await removeCliShim(paths.shimDir, shimName);
  }

  // Remove repo directory
  await rm(skill.install_path, { recursive: true, force: true });

  // Remove from database (CASCADE deletes capabilities)
  removeSkill(db, name);

  return { success: true, name };
}
