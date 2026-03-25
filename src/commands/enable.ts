import { join } from "path";
import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, updateSkillStatus } from "../lib/db.js";
import { readManifest } from "../lib/manifest.js";
import { createSymlink, createCliShim } from "../lib/symlinks.js";

export interface EnableResult {
  success: boolean;
  name?: string;
  error?: string;
}

/**
 * Re-enable a disabled skill.
 * Re-creates symlinks and updates database status.
 */
export async function enable(
  db: Database,
  paths: PaiPaths,
  name: string
): Promise<EnableResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, error: `Skill '${name}' is not installed` };
  }
  if (skill.status === "active") {
    return { success: false, error: `Skill '${name}' is already active` };
  }

  const isTool = skill.artifact_type === "tool";
  const manifest = await readManifest(skill.install_path);

  if (isTool) {
    // Tools: re-create bin symlink (repo root to binDir)
    const binLinkPath = join(paths.binDir, name);
    await createSymlink(skill.install_path, binLinkPath);

    // Re-create CLI shim
    if (manifest) {
      await createCliShim(paths.shimDir, paths.binDir, manifest);
    }
  } else {
    // Skills: re-create skill symlink
    const skillSourceDir = join(skill.install_path, "skill");
    const skillLinkPath = join(paths.skillsDir, name);

    if (existsSync(skillSourceDir)) {
      await createSymlink(skillSourceDir, skillLinkPath);
    } else {
      await createSymlink(skill.install_path, skillLinkPath);
    }

    // Re-create bin symlink and CLI shim if CLI declared
    if (manifest?.provides?.cli?.length) {
      const binName =
        manifest.provides.cli[0].name ??
        name.replace(/^_/, "").toLowerCase();
      const binLinkPath = join(paths.binDir, binName);
      await createSymlink(skill.install_path, binLinkPath);
      await createCliShim(paths.shimDir, paths.binDir, manifest);
    }
  }

  // Update database
  updateSkillStatus(db, name, "active");

  return { success: true, name };
}
