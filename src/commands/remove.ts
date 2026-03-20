import { join } from "path";
import { rm } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, removeSkill } from "../lib/db.js";
import { removeSymlink, removeCliShim } from "../lib/symlinks.js";

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

  // Remove skill symlink
  const skillLink = join(paths.skillsDir, name);
  await removeSymlink(skillLink);

  // Remove bin symlink
  const binName = name.replace(/^_/, "").toLowerCase();
  const binLink = join(paths.binDir, binName);
  await removeSymlink(binLink);

  // Remove CLI shim from PATH
  await removeCliShim(paths.shimDir, binName);

  // Remove repo directory
  await rm(skill.install_path, { recursive: true, force: true });

  // Remove from database (CASCADE deletes capabilities)
  removeSkill(db, name);

  return { success: true, name };
}
