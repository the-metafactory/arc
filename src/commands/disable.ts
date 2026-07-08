import { join } from "path";
import type { Database } from "bun:sqlite";
import type { ArcPaths, HostAdapter } from "../types.js";
import { getSkill, updateSkillStatus } from "../lib/db.js";
import { removeSymlink, removeCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks } from "../lib/hooks.js";

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
  arc: ArcPaths,
  host: HostAdapter,
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
  const isPipeline = skill.artifact_type === "pipeline";

  const manifest = await readManifest(skill.install_path);

  if (isPipeline) {
    // Pipelines: remove pipeline symlink
    const pipelineLink = join(arc.pipelinesDir, name);
    await removeSymlink(pipelineLink);
  } else if (isAgent) {
    // Agents: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(host.paths.agentsDir, `${name}.md`);
    const dirLink = join(host.paths.agentsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else if (isPrompt) {
    // Prompts: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(host.paths.promptsDir, `${name}.md`);
    const dirLink = join(host.paths.promptsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else if (!isTool) {
    // Skills: remove skill symlink
    const skillLink = join(host.paths.skillsDir, name);
    await removeSymlink(skillLink);
  }

  // Remove all CLI shims and bin symlinks (skills and tools)
  if (!isAgent && !isPrompt && manifest) {
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      await removeCliShim(arc.shimDir, entry.binName);
      await removeSymlink(join(host.paths.binDir, entry.binName));
    }
    if (!cliEntries.length) {
      const fallbackName = isTool ? name.toLowerCase() : name.replace(/^_/, "").toLowerCase();
      await removeCliShim(arc.shimDir, fallbackName);
      await removeSymlink(join(host.paths.binDir, fallbackName));
    }
  }
  // arc#137: same fix as `arc remove` — always invoke removeHooks. The
  // `_arc_pkg` tag (or legacy `_pai_pkg`, arc#276) inside removeHooks
  // filters to this package's entries only, so the call is idempotent
  // when nothing matches. Gating on
  // `manifest?.provides?.hooks` left orphan settings.json entries when
  // the source repo was deleted out-of-band or the hooks declaration
  // was dropped in a later version.
  await removeHooks(name, host.paths.settingsPath);

  // Update database
  updateSkillStatus(db, name, "disabled");

  return { success: true, name };
}
