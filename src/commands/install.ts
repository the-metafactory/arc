import { join, dirname } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type { PaiPaths, PaiManifest, PackageTier } from "../types.js";
import type { Database } from "bun:sqlite";
import { readManifest, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { recordInstall, getSkill } from "../lib/db.js";
import { createSymlink, createCliShim, extractCliInfo } from "../lib/symlinks.js";
import { runScript } from "../lib/scripts.js";
import { registerHooks, resolveHooksFromManifest, hasHooks } from "../lib/hooks.js";

export interface InstallOptions {
  paths: PaiPaths;
  db: Database;
  repoUrl: string;
  /** Skip capability display confirmation (for non-interactive / test use) */
  yes?: boolean;
  /** Source this package is being installed from */
  sourceName?: string;
  /** Trust tier of the source */
  sourceTier?: PackageTier;
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

  // S2: Path traversal guard — ensure installPath stays inside reposDir
  const normalizedInstall = join(installPath); // resolves ../ segments
  const normalizedRepos = join(paths.reposDir);
  if (!normalizedInstall.startsWith(normalizedRepos + "/") && normalizedInstall !== normalizedRepos) {
    return {
      success: false,
      error: `Refusing to install: repo name "${repoName}" would escape repos directory`,
    };
  }

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
    // Clean up stale clone from a previous failed install
    Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
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

  // 2b. Install package dependencies (other arc packages)
  if (manifest.depends_on?.packages?.length) {
    for (const dep of manifest.depends_on.packages) {
      if (!dep.repo) {
        if (!opts.yes) {
          console.log(`  Skipping dependency ${dep.name}: no repo URL specified`);
        }
        continue;
      }

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
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";

    if (tier === "custom" || !opts.sourceName) {
      console.log(`\n⚠️  UNKNOWN SOURCE — review capabilities carefully`);
    } else if (tier === "community") {
      console.log(`\n📦 Community source: ${opts.sourceName}`);
    }

    console.log(`\nInstall: ${manifest.name} v${manifest.version}`);
    const author = manifest.author ?? manifest.authors?.[0];
    if (author) {
      console.log(`Author: ${author.name} (${author.github})`);
    }
    console.log(`Source: ${opts.sourceName ?? "direct URL"} [${tier}]`);
    console.log(`Risk: ${risk.toUpperCase()}`);

    if (tier !== "official") {
      console.log(`\nCapabilities:`);
      for (const line of capLines) {
        console.log(line);
      }
    }
  }

  // 3b. Run preinstall script if declared
  if (manifest.scripts?.preinstall) {
    const preResult = runScript({
      installPath,
      scriptPath: manifest.scripts.preinstall,
      hookName: "preinstall",
      quiet: opts.yes,
    });
    if (!preResult.success && !preResult.skipped) {
      return {
        success: false,
        error: `Preinstall script failed (exit ${preResult.exitCode})`,
      };
    }
  }

  // 4. Create symlinks based on artifact type
  const isTool = manifest.type === "tool";
  const isAgent = manifest.type === "agent";
  const isPrompt = manifest.type === "prompt";
  const isComponent = manifest.type === "component";

  if (isComponent) {
    // Components: symlink each provides.files entry from repo source to expanded target
    const files = manifest.provides?.files ?? [];
    for (const file of files) {
      const sourcePath = join(installPath, file.source);
      const targetPath = file.target.replace(/^~/, homedir());
      await mkdir(dirname(targetPath), { recursive: true });
      await createSymlink(sourcePath, targetPath);
    }
  } else if (isTool) {
    // Tools: symlink repo root to binDir (no skill/ subdirectory)
    const binLinkPath = join(paths.binDir, manifest.name);
    await createSymlink(installPath, binLinkPath);

    // Create PATH-accessible shim
    await createCliShim(paths.shimDir, paths.binDir, manifest);
  } else if (isAgent) {
    // Agents: symlink the .md file directly into agentsDir for Claude auto-discovery
    const agentSourceDir = join(installPath, "agent");
    const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : installPath;
    const mdFile = `${manifest.name}.md`;
    const sourcePath = join(sourceDir, mdFile);
    const linkPath = join(paths.agentsDir, mdFile);

    if (existsSync(sourcePath)) {
      await createSymlink(sourcePath, linkPath);
    } else {
      // Fallback: symlink directory if .md file not found by convention name
      await createSymlink(sourceDir, join(paths.agentsDir, manifest.name));
    }
  } else if (isPrompt) {
    // Prompts: symlink the .md file directly into promptsDir for Claude auto-discovery
    const promptSourceDir = join(installPath, "prompt");
    const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : installPath;
    const mdFile = `${manifest.name}.md`;
    const sourcePath = join(sourceDir, mdFile);
    const linkPath = join(paths.promptsDir, mdFile);

    if (existsSync(sourcePath)) {
      await createSymlink(sourcePath, linkPath);
    } else {
      // Fallback: symlink directory if .md file not found by convention name
      await createSymlink(sourceDir, join(paths.promptsDir, manifest.name));
    }
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

  // 5b. Register hooks (if declared, with consent gating)
  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    installPath,
    manifest.name,
  );
  if (resolvedHooks?.length) {
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";
    const approved = await promptHookConsent(
      manifest.name,
      tier,
      resolvedHooks,
      opts.yes,
    );
    if (approved) {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      await registerHooks(manifest.name, resolvedHooks, settingsPath);
      if (!opts.yes) {
        console.log("  \u2713 Hooks registered in settings.json");
      }
    } else {
      if (!opts.yes) {
        console.log("  \u2298 Hook registration declined");
      }
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

  // 6b. Run postinstall script if declared
  if (manifest.scripts?.postinstall) {
    const postResult = runScript({
      installPath,
      scriptPath: manifest.scripts.postinstall,
      hookName: "postinstall",
      quiet: opts.yes,
    });
    if (!postResult.success && !postResult.skipped) {
      return {
        success: false,
        error: `Postinstall script failed (exit ${postResult.exitCode})`,
      };
    }
  }

  // 7. Record in database
  const now = new Date().toISOString();
  const artifactType = isComponent ? "component" : isTool ? "tool" : isAgent ? "agent" : isPrompt ? "prompt" : "skill";
  const artifactSourceDir = isComponent ? installPath
    : isTool ? installPath
    : isAgent ? join(installPath, "agent")
    : isPrompt ? join(installPath, "prompt")
    : join(installPath, "skill");
  recordInstall(
    db,
    {
      name: manifest.name,
      version: manifest.version,
      repo_url: repoUrl,
      install_path: installPath,
      skill_dir: existsSync(artifactSourceDir) ? artifactSourceDir : installPath,
      status: "active",
      artifact_type: artifactType,
      tier: opts.sourceTier ?? manifest.tier ?? "custom",
      customization_path: null,
      install_source: opts.sourceName ?? null,
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
 * Consent gate for hook registration based on trust tier.
 *
 * - official/sponsored tier: auto-approve (silent for --yes)
 * - community/custom tier: show hooks and prompt for approval
 * - --yes flag: auto-approve regardless of tier
 */
async function promptHookConsent(
  packageName: string,
  tier: string,
  hooks: Array<{ event: string; command: string; matcher?: string }>,
  autoApprove?: boolean,
): Promise<boolean> {
  // Auto-approve for --yes flag or trusted tiers
  if (autoApprove) return true;
  if (tier === "official") return true;

  // Show hook details
  console.log(`\n\u{1F4CB} ${packageName} wants to register hooks:`);
  for (const hook of hooks) {
    const matcherLabel = hook.matcher ? ` (${hook.matcher})` : "";
    console.log(`  \u2022 ${hook.event}${matcherLabel} \u2192 ${hook.command}`);
  }
  console.log("");
  console.log("Hooks run during Claude Code sessions.");

  // Community/custom: ask for approval
  if (tier === "community" || tier === "custom") {
    process.stdout.write("Allow? [y/N] ");
    const response = await readLine();
    return response.trim().toLowerCase() === "y";
  }

  // Other trusted tiers: auto-approve
  return true;
}

/**
 * Read a single line from stdin.
 */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    stdin.resume();
    stdin.once("data", (data: string) => {
      stdin.pause();
      resolve(data);
    });
  });
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
