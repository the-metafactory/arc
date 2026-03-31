import { join } from "path";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, updateSkillStatus } from "../lib/db.js";
import { removeSymlink, removeCliShim } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks, hasHooks } from "../lib/hooks.js";

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
  const isAgent = skill.artifact_type === "agent";
  const isPrompt = skill.artifact_type === "prompt";

  if (isTool) {
    // Tools: remove bin symlink
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

    // Remove bin symlink if it exists (skills with CLI)
    const binName = name.replace(/^_/, "").toLowerCase();
    const binLink = join(paths.binDir, binName);
    await removeSymlink(binLink);
  }

  // Remove CLI shim from PATH (only for skills and tools)
  if (!isAgent && !isPrompt) {
    const shimName = isTool ? name.toLowerCase() : name.replace(/^_/, "").toLowerCase();
    await removeCliShim(paths.shimDir, shimName);
  }

  // Remove hooks from settings.json
  const manifest = await readManifest(skill.install_path);
  if (hasHooks(manifest?.provides?.hooks)) {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    await removeHooks(name, settingsPath);
  }

  // Update database
  updateSkillStatus(db, name, "disabled");

  return { success: true, name };
}
