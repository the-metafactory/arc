import { join } from "path";
import { existsSync } from "fs";
import type { PaiPaths, PaiManifest } from "../types.js";
import type { Database } from "bun:sqlite";
import { readManifest, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { recordInstall, getSkill } from "../lib/db.js";
import { createSymlink, createCliShim, extractCliInfo } from "../lib/symlinks.js";

export interface InstallOptions {
  paths: PaiPaths;
  db: Database;
  repoUrl: string;
  /** Skip capability display confirmation (for non-interactive / test use) */
  yes?: boolean;
}

export interface InstallResult {
  success: boolean;
  name?: string;
  version?: string;
  error?: string;
  manifest?: PaiManifest;
}

/**
 * Install a skill from a git repo URL.
 *
 * Flow:
 * 1. Clone repo to repos directory
 * 2. Read pai-manifest.yaml
 * 3. Display capabilities + risk level
 * 4. Create skill symlink
 * 5. Create bin symlink (if CLI declared)
 * 6. Run bun install (if package.json in repo root)
 * 7. Record in database
 */
export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { paths, db, repoUrl } = opts;

  // 1. Clone repo
  const repoName = extractRepoName(repoUrl);
  const installPath = join(paths.reposDir, repoName);

  // Check if already installed in DB (by repo name or by scanning all skills)
  const allSkills = db
    .prepare("SELECT * FROM skills")
    .all() as Array<{ name: string; status: string; repo_url: string }>;

  const existingByUrl = allSkills.find((s) => s.repo_url === repoUrl);
  if (existingByUrl) {
    return {
      success: false,
      error: `Skill '${existingByUrl.name}' is already installed (status: ${existingByUrl.status})`,
    };
  }

  if (existsSync(installPath)) {
    const existingByPath = allSkills.find((s) =>
      s.repo_url.endsWith(repoName)
    );
    if (existingByPath) {
      return {
        success: false,
        error: `Skill '${existingByPath.name}' is already installed (status: ${existingByPath.status})`,
      };
    }
  }

  const cloneResult = Bun.spawnSync(["git", "clone", repoUrl, installPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (cloneResult.exitCode !== 0) {
    return {
      success: false,
      error: `git clone failed: ${cloneResult.stderr.toString().trim()}`,
    };
  }

  // 2. Read manifest
  const manifest = await readManifest(installPath);
  if (!manifest) {
    // Cleanup cloned repo
    Bun.spawnSync(["rm", "-rf", installPath]);
    return {
      success: false,
      error: `No pai-manifest.yaml found in ${repoUrl}`,
    };
  }

  // 2b. Install package dependencies (other pai-pkg packages)
  if (manifest.depends_on?.packages?.length) {
    for (const dep of manifest.depends_on.packages) {
      const existing = db
        .prepare("SELECT name, status FROM skills WHERE name = ?")
        .get(dep.name) as { name: string; status: string } | null;

      if (existing && existing.status === "active") {
        continue; // Already installed
      }

      if (!opts.yes) {
        console.log(`\nInstalling dependency: ${dep.name} (${dep.repo})`);
      }

      const depResult = await install({
        paths,
        db,
        repoUrl: dep.repo,
        yes: opts.yes,
      });

      if (!depResult.success) {
        return {
          success: false,
          error: `Failed to install dependency '${dep.name}': ${depResult.error}`,
        };
      }

      if (!opts.yes) {
        console.log(`  ✓ ${dep.name} v${depResult.version}`);
      }
    }
  }

  // 3. Display capabilities
  const risk = assessRisk(manifest);
  const capLines = formatCapabilities(manifest);

  if (!opts.yes) {
    console.log(`\nInstall: ${manifest.name} v${manifest.version}`);
    console.log(`Author: ${manifest.author.name} (${manifest.author.github})`);
    console.log(`Risk: ${risk.toUpperCase()}`);
    console.log(`\nCapabilities:`);
    for (const line of capLines) {
      console.log(line);
    }
  }

  // 4. Create symlinks based on artifact type
  const isTool = manifest.type === "tool";

  if (isTool) {
    // Tools: symlink repo root to binDir (no skill/ subdirectory)
    const binLinkPath = join(paths.binDir, manifest.name);
    await createSymlink(installPath, binLinkPath);

    // Create PATH-accessible shim
    await createCliShim(paths.shimDir, paths.binDir, manifest);
  } else {
    // Skills: symlink skill/ subdirectory (or root) to skillsDir
    const skillSourceDir = join(installPath, "skill");
    const skillLinkPath = join(paths.skillsDir, manifest.name);

    if (existsSync(skillSourceDir)) {
      await createSymlink(skillSourceDir, skillLinkPath);
    } else {
      await createSymlink(installPath, skillLinkPath);
    }

    // Create bin symlink if CLI declared (skills with CLI)
    const cliInfo = extractCliInfo(manifest);
    if (cliInfo) {
      const binLinkPath = join(paths.binDir, cliInfo.binName);
      await createSymlink(installPath, binLinkPath);
      await createCliShim(paths.shimDir, paths.binDir, manifest);
    }
  }

  // 6. Run bun install if package.json exists
  const packageJsonPath = join(installPath, "package.json");
  if (existsSync(packageJsonPath)) {
    Bun.spawnSync(["bun", "install"], {
      cwd: installPath,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  // 7. Record in database
  const now = new Date().toISOString();
  const skillSourceDir = isTool ? installPath : join(installPath, "skill");
  recordInstall(
    db,
    {
      name: manifest.name,
      version: manifest.version,
      repo_url: repoUrl,
      install_path: installPath,
      skill_dir: isTool ? installPath : skillSourceDir,
      status: "active",
      artifact_type: isTool ? "tool" : "skill",
      installed_at: now,
      updated_at: now,
    },
    manifest
  );

  return {
    success: true,
    name: manifest.name,
    version: manifest.version,
    manifest,
  };
}

/**
 * Extract a reasonable name from a repo URL.
 * Handles: /path/to/repo, git@github.com:user/repo.git, https://github.com/user/repo
 */
function extractRepoName(url: string): string {
  // Local path
  if (url.startsWith("/") || url.startsWith(".")) {
    const parts = url.split("/").filter(Boolean);
    return parts[parts.length - 1].replace(/\.git$/, "");
  }

  // SSH: git@github.com:user/repo.git
  const sshMatch = url.match(/[:\/]([^\/]+)\.git$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/user/repo
  const parts = url.split("/").filter(Boolean);
  return parts[parts.length - 1].replace(/\.git$/, "");
}
