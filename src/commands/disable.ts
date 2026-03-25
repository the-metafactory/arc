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

  const isTool = skill.artifact_type === "tool";

  if (isTool) {
    // Tools: remove bin symlink
    const binLink = join(paths.binDir, name);
    await removeSymlink(binLink);
  } else {
    // Skills: remove skill symlink
    const skillLink = join(paths.skillsDir, name);
    await removeSymlink(skillLink);

    // Remove bin symlink if it exists (skills with CLI)
    const binName = name.replace(/^_/, "").toLowerCase();
    const binLink = join(paths.binDir, binName);
    await removeSymlink(binLink);
  }

  // Remove CLI shim from PATH
  const shimName = isTool ? name.toLowerCase() : name.replace(/^_/, "").toLowerCase();
  await removeCliShim(paths.shimDir, shimName);

  // Update database
  updateSkillStatus(db, name, "disabled");

  return { success: true, name };
}
