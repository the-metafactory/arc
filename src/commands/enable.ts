import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill, updateSkillStatus } from "../lib/db.js";
import { readManifest } from "../lib/manifest.js";
import { createSymlink, createCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { registerHooks, resolveHooksFromManifest } from "../lib/hooks.js";

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
  const isAgent = skill.artifact_type === "agent";
  const isPrompt = skill.artifact_type === "prompt";
  const manifest = await readManifest(skill.install_path);

  if (isTool) {
    // Tools: re-create bin symlinks for all CLI entries
    if (manifest) {
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        await createSymlink(skill.install_path, join(paths.binDir, entry.binName));
      }
      if (!cliEntries.length) {
        await createSymlink(skill.install_path, join(paths.binDir, name));
      }
      await createCliShim(paths.shimDir, paths.binDir, manifest);
    }
  } else if (isAgent) {
    // Agents: re-create .md file symlink for Claude auto-discovery
    const agentSourceDir = join(skill.install_path, "agent");
    const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : skill.install_path;
    const mdFile = `${name}.md`;
    const sourcePath = join(sourceDir, mdFile);
    const linkPath = join(paths.agentsDir, mdFile);

    if (existsSync(sourcePath)) {
      await createSymlink(sourcePath, linkPath);
    } else {
      await createSymlink(sourceDir, join(paths.agentsDir, name));
    }
  } else if (isPrompt) {
    // Prompts: re-create .md file symlink for Claude auto-discovery
    const promptSourceDir = join(skill.install_path, "prompt");
    const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : skill.install_path;
    const mdFile = `${name}.md`;
    const sourcePath = join(sourceDir, mdFile);
    const linkPath = join(paths.promptsDir, mdFile);

    if (existsSync(sourcePath)) {
      await createSymlink(sourcePath, linkPath);
    } else {
      await createSymlink(sourceDir, join(paths.promptsDir, name));
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

    // Re-create bin symlinks and CLI shims for all CLI entries
    if (manifest) {
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        await createSymlink(skill.install_path, join(paths.binDir, entry.binName));
      }
      if (cliEntries.length) {
        await createCliShim(paths.shimDir, paths.binDir, manifest);
      }
    }
  }

  // Re-register hooks when enabling (consent was given at install time)
  const resolvedHooks = resolveHooksFromManifest(
    manifest?.provides?.hooks,
    skill.install_path,
    name,
  );
  if (resolvedHooks?.length) {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    await registerHooks(name, resolvedHooks, settingsPath);
  }

  // Update database
  updateSkillStatus(db, name, "active");

  return { success: true, name };
}
