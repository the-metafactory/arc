import { join } from "path";
import { rm } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, removeSkill, listByLibrary } from "../lib/db.js";
import { removeSymlink, removeCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks, hasHooks } from "../lib/hooks.js";
import { findGitRoot } from "../lib/paths.js";

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
  const isPipeline = skill.artifact_type === "pipeline";
  const isAction = skill.artifact_type === "action";

  if (isAction) {
    // Actions: remove action symlink
    const actionLink = join(paths.actionsDir, name);
    await removeSymlink(actionLink);
  } else if (isPipeline) {
    // Pipelines: remove pipeline symlink
    const pipelineLink = join(paths.pipelinesDir, name);
    await removeSymlink(pipelineLink);
  } else if (isTool) {
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
  if (hasHooks(manifest?.provides?.hooks)) {
    const settingsPath = paths.settingsPath;
    await removeHooks(name, settingsPath);
  }

  // Remove from database (CASCADE deletes capabilities) — before repo removal
  removeSkill(db, name);

  // Remove repo directory — but NOT if other library artifacts still reference it
  if (skill.library_name) {
    const siblings = listByLibrary(db, skill.library_name);
    if (siblings.length === 0) {
      // Last artifact from this library — safe to remove the entire repo clone
      // The repo clone is the parent of install_path for library artifacts
      // install_path points to the artifact subdir, so we need the library root
      const repoRoot = findGitRoot(skill.install_path);
      if (repoRoot) {
        await rm(repoRoot, { recursive: true, force: true });
      }
    }
    // If siblings remain, leave the repo clone in place
  } else {
    // Standalone package — remove repo directory as before
    await rm(skill.install_path, { recursive: true, force: true });
  }

  return { success: true, name };
}
