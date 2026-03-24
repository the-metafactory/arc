import { homedir } from "os";
import { resolve, dirname, basename } from "path";
import type { ResolvedSource } from "../types.js";

/**
 * Resolve a catalog source string into a structured clone target.
 *
 * Supports three formats:
 *   Local:   /abs/path/to/SKILL.md  or  ~/relative/path/to/SKILL.md
 *   GitHub:  https://github.com/org/repo/blob/branch/path/to/SKILL.md
 *   Raw:     https://raw.githubusercontent.com/org/repo/branch/path/to/SKILL.md
 */
export function resolveSource(source: string): ResolvedSource {
  if (source.startsWith("https://raw.githubusercontent.com/")) {
    return parseRawGitHubUrl(source);
  }

  if (source.startsWith("https://github.com/")) {
    return parseBrowserGitHubUrl(source);
  }

  // Local path
  return parseLocalPath(source);
}

function parseLocalPath(source: string): ResolvedSource {
  const expanded = source.startsWith("~")
    ? source.replace(/^~/, homedir())
    : source;

  const abs = resolve(expanded);
  const parent = dirname(abs);
  const file = basename(abs);

  return {
    type: "local",
    cloneUrl: parent,
    parentPath: parent,
    filename: file,
  };
}

/**
 * Parse: https://github.com/org/repo/blob/branch/path/to/FILE.md
 *
 * Parts after splitting on '/':
 *   [0]='https:', [1]='', [2]='github.com', [3]=org, [4]=repo,
 *   [5]='blob', [6]=branch, [7..n]=path segments
 */
function parseBrowserGitHubUrl(source: string): ResolvedSource {
  const url = new URL(source);
  const parts = url.pathname.split("/").filter(Boolean);
  // parts: [org, repo, 'blob', branch, ...pathSegments]

  if (parts.length < 5 || parts[2] !== "blob") {
    throw new Error(
      `Invalid GitHub browser URL: ${source}. Expected format: https://github.com/org/repo/blob/branch/path/to/file`
    );
  }

  const org = parts[0];
  const repo = parts[1];
  const branch = parts[3];
  const pathSegments = parts.slice(4);
  const filename = pathSegments[pathSegments.length - 1];
  const parentPath =
    pathSegments.length > 1
      ? pathSegments.slice(0, -1).join("/")
      : ".";

  return {
    type: "github",
    cloneUrl: `https://github.com/${org}/${repo}.git`,
    org,
    repo,
    branch,
    parentPath,
    filename,
  };
}

/**
 * Parse: https://raw.githubusercontent.com/org/repo/branch/path/to/FILE.md
 *
 * Parts after splitting on '/':
 *   [0]=org, [1]=repo, [2]=branch, [3..n]=path segments
 */
function parseRawGitHubUrl(source: string): ResolvedSource {
  const url = new URL(source);
  const parts = url.pathname.split("/").filter(Boolean);
  // parts: [org, repo, branch, ...pathSegments]

  if (parts.length < 4) {
    throw new Error(
      `Invalid GitHub raw URL: ${source}. Expected format: https://raw.githubusercontent.com/org/repo/branch/path/to/file`
    );
  }

  const org = parts[0];
  const repo = parts[1];
  const branch = parts[2];
  const pathSegments = parts.slice(3);
  const filename = pathSegments[pathSegments.length - 1];
  const parentPath =
    pathSegments.length > 1
      ? pathSegments.slice(0, -1).join("/")
      : ".";

  return {
    type: "github",
    cloneUrl: `https://github.com/${org}/${repo}.git`,
    org,
    repo,
    branch,
    parentPath,
    filename,
  };
}

/**
 * Parse a typed dependency reference like "skill:Thinking" or "agent:Architect".
 * Returns the artifact type and name.
 */
export function parseDependencyRef(ref: string): {
  artifactType: "skill" | "agent" | "prompt";
  name: string;
} {
  const colonIdx = ref.indexOf(":");
  if (colonIdx === -1) {
    // Default to skill if no type prefix
    return { artifactType: "skill", name: ref };
  }

  const typeStr = ref.slice(0, colonIdx);
  const name = ref.slice(colonIdx + 1);

  if (typeStr !== "skill" && typeStr !== "agent" && typeStr !== "prompt") {
    throw new Error(
      `Invalid dependency type "${typeStr}" in ref "${ref}". Must be skill, agent, or prompt.`
    );
  }

  return { artifactType: typeStr, name };
}
