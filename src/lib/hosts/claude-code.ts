import { join } from "path";
import { existsSync } from "fs";
import type { ArtifactType, HostAdapter, HostPaths } from "../../types.js";
import { userHome } from "../user-home.js";

/**
 * Claude Code host adapter.
 *
 * Phase 1 default: installs to ~/.claude/{skills,agents,commands,bin} and writes
 * hooks into ~/.claude/settings.json. Detected when the directory exists (the
 * `claude` binary is also acceptable but the dir is enough for current users).
 */

/** Build Claude-Code paths rooted at the given Claude home. */
export function claudeCodePaths(claudeRoot: string): HostPaths {
  return {
    root: claudeRoot,
    skillsDir: join(claudeRoot, "skills"),
    agentsDir: join(claudeRoot, "agents"),
    promptsDir: join(claudeRoot, "commands"),
    binDir: join(claudeRoot, "bin"),
    settingsPath: join(claudeRoot, "settings.json"),
  };
}

export function createClaudeCodeHost(opts?: { root?: string }): HostAdapter {
  // `userHome()`, not a raw `homedir()` (arc#421 round 4, minor): this is the
  // default root for every skill, agent, command and hook arc installs, and a
  // raw `homedir()` here is unreachable by an in-process $HOME pin.
  const root = opts?.root ?? join(userHome(), ".claude");
  return {
    id: "claude-code",
    paths: claudeCodePaths(root),
    detect: () => existsSync(root),
    supports: (type: ArtifactType) =>
      type === "skill" ||
      type === "agent" ||
      type === "prompt" ||
      type === "tool" ||
      type === "component" ||
      type === "rules" ||
      type === "governance" ||
      type === "library",
  };
}
