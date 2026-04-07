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
    const sshMatch = url.match(/[:\/]([^\/]+)\.git$/);
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
