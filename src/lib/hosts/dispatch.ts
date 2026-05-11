import type { ArtifactType, HostAdapter } from "../../types.js";

/**
 * Map an artifact type to its install directory on a given host.
 *
 * Returns `null` for types that don't live inside a host's directory tree:
 *
 *   - `pipeline` / `action` — arc state (`~/.config/metafactory/{pipelines,actions}/`)
 *   - `rules`               — writes templates into the consumer repo
 *   - `library`             — meta type; contained artifacts route individually
 *   - `component`           — no per-type primary layout; uses provides.files only
 *
 * Phase 2 install dispatch (per #117) uses this to ask the host "where does
 * this go on you?" instead of hard-coding `host.paths.skillsDir` etc. at
 * every call site. When future adapters land (Codex, Cursor, …) they can
 * differ on directory naming without changing dispatch code.
 *
 * Returning `null` is the right "I cannot install this" signal — callers
 * should fall back to the arc-state path or the consumer repo, never invent
 * a host directory the adapter didn't promise.
 */
export function hostPathFor(
  host: HostAdapter,
  type: ArtifactType | "system",
): string | null {
  switch (type) {
    case "skill":
    case "system":
      return host.paths.skillsDir;
    case "agent":
      return host.paths.agentsDir;
    case "prompt":
      return host.paths.promptsDir;
    case "tool":
      return host.paths.binDir;
    case "component":
    case "rules":
    case "library":
    case "pipeline":
    case "action":
      return null;
    default:
      return null;
  }
}
