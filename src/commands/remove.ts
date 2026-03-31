import { join } from "path";
import { rm } from "fs/promises";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, removeSkill } from "../lib/db.js";
import { removeSymlink, removeCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks } from "../lib/hooks.js";

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
  }

  // Read manifest before removal (needed for CLI shim names and hooks cleanup)
  const manifest = await readManifest(skill.install_path);

  // Remove all CLI shims and bin symlinks (skills and tools)
  if (!isAgent && !isPrompt && manifest) {
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      await removeCliShim(paths.shimDir, entry.binName);
      await removeSymlink(join(paths.binDir, entry.binName));
    }
    if (!cliEntries.length) {
      // Fallback: remove by conventional name
      const fallbackName = isTool ? name.toLowerCase() : name.replace(/^_/, "").toLowerCase();
      await removeCliShim(paths.shimDir, fallbackName);
      await removeSymlink(join(paths.binDir, fallbackName));
    }
  }

  // Remove hooks from settings.json (before deleting repo)
  if (manifest?.provides?.hooks?.length) {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    await removeHooks(name, settingsPath);
  }

  // Remove repo directory
  await rm(skill.install_path, { recursive: true, force: true });

  // Remove from database (CASCADE deletes capabilities)
  removeSkill(db, name);

  return { success: true, name };
}
