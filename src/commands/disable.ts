import { join } from "path";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, updateSkillStatus } from "../lib/db.js";
import { removeSymlink, removeCliShim } from "../lib/symlinks.js";

export interface DisableResult {
  success: boolean;
  name?: string;
  error?: string;
}

/**
 * Disable an installed skill.
 * Removes symlink but preserves the repo and database entry.
 */
export async function disable(
  db: Database,
  paths: PaiPaths,
  name: string
): Promise<DisableResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, error: `Skill '${name}' is not installed` };
  }
  if (skill.status === "disabled") {
    return { success: false, error: `Skill '${name}' is already disabled` };
  }

  // Remove skill symlink
  const skillLink = join(paths.skillsDir, name);
  await removeSymlink(skillLink);

  // Remove bin symlink if it exists
  const binName = name.replace(/^_/, "").toLowerCase();
  const binLink = join(paths.binDir, binName);
  await removeSymlink(binLink);

  // Remove CLI shim from PATH
  await removeCliShim(paths.shimDir, binName);

  // Update database
  updateSkillStatus(db, name, "disabled");

  return { success: true, name };
}
