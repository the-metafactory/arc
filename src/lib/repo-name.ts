import nodePath from "path";

/**
 * A subset of the Node `path` API selectable per OS flavor.
 *
 * The install path guard must behave correctly on the OS it runs on, but the
 * platform-default `path` resolves to posix on a macOS/Linux CI — so the
 * Windows (`\`-separator) behavior would be untestable there. By threading a
 * `PathFlavor` through the pure helpers below, the install call sites use the
 * platform default (`nodePath`) while tests can pass `path.win32` / `path.posix`
 * explicitly to prove cross-platform correctness on any host. See issue #219.
 */
export type PathFlavor = Pick<typeof nodePath, "basename" | "relative" | "isAbsolute">;

/**
 * Containment guard: is `installPath` the repos dir itself, or a path nested
 * inside it? Uses `path.relative` so a `..`-escape (the relative path starts
 * with `..`) or an absolute relative path (different drive/root on Windows) is
 * rejected, while a legitimately nested child is accepted — on every separator
 * flavor. Replaces the separator-naive `startsWith(reposDir + "/")` check that
 * false-rejected valid `\`-separated Windows paths (#219).
 *
 * @param reposDir    The configured repos directory.
 * @param installPath The resolved install destination.
 * @param p           Path flavor (defaults to the platform's `path`).
 */
export function isInsideRepos(
  reposDir: string,
  installPath: string,
  p: PathFlavor = nodePath,
): boolean {
  const rel = p.relative(reposDir, installPath);
  // rel === "" → installPath IS reposDir (the boundary case, allowed).
  // rel starts with ".." → escapes above reposDir.
  // rel is absolute → unrelated root (e.g. different Windows drive).
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * Derive the repo (directory) name from a pre-extracted registry install path.
 *
 * Uses `path.basename` so it works for both `/`- and `\`-separated paths —
 * unlike the previous `split("/").pop()`, which returned the WHOLE path on
 * Windows (the install then echoed the full path as the "repo name" in the
 * escape error — #219). Returns `undefined` when there is no pre-extracted
 * path so the caller can fall back to deriving the name from the repo URL.
 *
 * @param preExtractedPath The extracted directory path, or undefined.
 * @param p                Path flavor (defaults to the platform's `path`).
 */
export function repoNameFromPreExtracted(
  preExtractedPath: string | undefined,
  p: PathFlavor = nodePath,
): string | undefined {
  if (!preExtractedPath) return undefined;
  // Strip a trailing separator so basename doesn't return "" on "…/name/".
  const trimmed = preExtractedPath.replace(/[/\\]+$/, "");
  const name = p.basename(trimmed);
  return name === "" ? undefined : name;
}

/**
 * Extract a safe directory name from a git repo URL.
 *
 * Handles local paths, SSH URLs, and HTTPS URLs.
 * Rejects names containing path traversal characters.
 */
export function extractRepoName(url: string): string {
  let name: string;

  // Local path
  if (url.startsWith("/") || url.startsWith(".")) {
    const parts = url.split("/").filter(Boolean);
    name = parts[parts.length - 1].replace(/\.git$/, "");
  }
  // SSH: git@github.com:user/repo.git
  else {
    const sshMatch = /[:/]([^/]+)\.git$/.exec(url);
    if (sshMatch) {
      name = sshMatch[1];
    } else {
      // HTTPS: https://github.com/user/repo
      const parts = url.split("/").filter(Boolean);
      name = parts[parts.length - 1].replace(/\.git$/, "");
    }
  }

  // Path traversal guard
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`Unsafe repo name derived from URL: "${url}"`);
  }

  return name;
}
