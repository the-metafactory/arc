import { join, dirname } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type { PaiPaths, ArcManifest, ArtifactType, PackageTier } from "../types.js";
import type { Database } from "bun:sqlite";
import { readManifest, readLibraryArtifacts, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { recordInstall, getSkill } from "../lib/db.js";
import { createSymlink, createCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { runScript } from "../lib/scripts.js";
import { registerHooks, resolveHooksFromManifest, hasHooks } from "../lib/hooks.js";
import { generateRules } from "../lib/rules.js";

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
  /** Consumer repo directory for rules template generation (defaults to cwd) */
  consumerDir?: string;
  /** When installing from a library, the specific artifact name to install */
  artifactName?: string;
  /** When installing from a library, the library name (for DB tracking) */
  libraryName?: string;
}

export interface InstallResult {
  success: boolean;
  name?: string;
  version?: string;
  error?: string;
  manifest?: ArcManifest;
  /** For library installs: results for each artifact */
  artifacts?: InstallResult[];
}

/**
 * Install a skill from a git repo URL.
 *
 * Flow:
 * 1. Clone repo to repos directory
 * 2. Read arc-manifest.yaml
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

  // For library artifact installs, skip the repo-level duplicate check
  // (multiple artifacts share the same repo URL)
  if (!opts.libraryName) {
    // Check if already installed in DB (by repo name or by scanning all skills)
    const allSkills = db
      .prepare("SELECT * FROM skills")
      .all() as Array<{ name: string; status: string; repo_url: string; library_name: string | null }>;

    const existingByUrl = allSkills.find((s) => s.repo_url === repoUrl && !s.library_name);
    if (existingByUrl) {
      return {
        success: false,
        error: `Skill '${existingByUrl.name}' is already installed (status: ${existingByUrl.status})`,
      };
    }

    if (existsSync(installPath)) {
      // Only clean up stale clone if no library artifacts are installed from it
      const existingByPath = allSkills.find((s) =>
        s.repo_url.endsWith(repoName)
      );
      if (existingByPath && !existingByPath.library_name) {
        return {
          success: false,
          error: `Skill '${existingByPath.name}' is already installed (status: ${existingByPath.status})`,
        };
      }
      // If no DB entries reference this path, clean up stale clone
      if (!existingByPath) {
        Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
      }
    }
  }

  // Only clone if not already present (library repos may already be cloned)
  if (!existsSync(installPath)) {
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
  }

  // 2. Read manifest
  const manifest = await readManifest(installPath);
  if (!manifest) {
    // Cleanup cloned repo
    Bun.spawnSync(["rm", "-rf", installPath]);
    return {
      success: false,
      error: `No arc-manifest.yaml (or pai-manifest.yaml) found in ${repoUrl}`,
    };
  }

  // 2a. Library detection — delegate to per-artifact installs
  if (manifest.type === "library") {
    return installLibrary(opts, installPath, manifest);
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
  const isPipeline = manifest.type === "pipeline";
  const isRules = manifest.type === "rules";

  if (isRules) {
    // Rules packages: run template generation in the consumer repo (cwd)
    const templates = manifest.provides?.templates ?? [];
    if (templates.length) {
      const consumerDir = opts.consumerDir ?? process.cwd();
      const results = await generateRules(installPath, templates, consumerDir);
      if (!opts.yes) {
        for (const r of results) {
          if (r.success && r.target) {
            console.log(`  Generated ${r.target}`);
          } else if (!r.success) {
            console.log(`  ⚠ ${r.target}: ${r.error}`);
          }
        }
      }
    }
  } else if (isPipeline) {
    // Pipelines: symlink repo root (or pipeline/ subdirectory) to pipelinesDir
    const pipelineSourceDir = join(installPath, "pipeline");
    const sourceDir = existsSync(pipelineSourceDir) ? pipelineSourceDir : installPath;
    const pipelineLinkPath = join(paths.pipelinesDir, manifest.name);
    await createSymlink(sourceDir, pipelineLinkPath);

    // If the manifest declares CLI entries, also create shims
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      const binLinkPath = join(paths.binDir, entry.binName);
      await createSymlink(installPath, binLinkPath);
    }
    if (cliEntries.length) {
      await createCliShim(paths.shimDir, paths.binDir, manifest);
    }
  } else if (isComponent) {
    // Components: symlink each provides.files entry from repo source to expanded target
    const files = manifest.provides?.files ?? [];
    for (const file of files) {
      const sourcePath = join(installPath, file.source);
      const targetPath = file.target.replace(/^~/, homedir());
      await mkdir(dirname(targetPath), { recursive: true });
      await createSymlink(sourcePath, targetPath);
    }
  } else if (isTool) {
    // Tools: symlink repo root to binDir for each CLI entry
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      const binLinkPath = join(paths.binDir, entry.binName);
      await createSymlink(installPath, binLinkPath);
    }
    if (!cliEntries.length) {
      // Fallback: symlink under manifest name if no CLI declared
      await createSymlink(installPath, join(paths.binDir, manifest.name));
    }

    // Create PATH-accessible shims for all CLI entries
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

    // Create bin symlinks and shims for all CLI entries (skills with CLI)
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      const binLinkPath = join(paths.binDir, entry.binName);
      await createSymlink(installPath, binLinkPath);
    }
    if (cliEntries.length) {
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
  const artifactType = isRules ? "rules" : isPipeline ? "pipeline" : isComponent ? "component" : isTool ? "tool" : isAgent ? "agent" : isPrompt ? "prompt" : "skill";
  const artifactSourceDir = isRules ? installPath
    : isPipeline ? (existsSync(join(installPath, "pipeline")) ? join(installPath, "pipeline") : installPath)
    : isComponent ? installPath
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
      library_name: opts.libraryName ?? null,
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
 * Install artifacts from a library repo.
 * If opts.artifactName is set, installs only that artifact.
 * Otherwise, installs all artifacts (with per-artifact confirmation when interactive).
 */
async function installLibrary(
  opts: InstallOptions,
  installPath: string,
  libraryManifest: ArcManifest,
): Promise<InstallResult> {
  const { db } = opts;
  const libraryName = libraryManifest.name;

  if (!opts.yes) {
    console.log(`\n📚 Library: ${libraryName} v${libraryManifest.version}`);
    const author = libraryManifest.author ?? libraryManifest.authors?.[0];
    if (author) {
      console.log(`Author: ${author.name} (${author.github})`);
    }
  }

  // Read all artifact manifests
  let artifactEntries: Awaited<ReturnType<typeof readLibraryArtifacts>>;
  try {
    artifactEntries = await readLibraryArtifacts(installPath, libraryManifest);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // Filter to specific artifact if requested
  if (opts.artifactName) {
    const match = artifactEntries.find(
      (a) => a.manifest.name === opts.artifactName
    );
    if (!match) {
      const available = artifactEntries.map((a) => a.manifest.name).join(", ");
      return {
        success: false,
        error: `Artifact '${opts.artifactName}' not found in library '${libraryName}'. Available: ${available}`,
      };
    }
    artifactEntries = [match];
  }

  if (!opts.yes && !opts.artifactName) {
    console.log(`\nArtifacts (${artifactEntries.length}):`);
    for (const { entry, manifest } of artifactEntries) {
      console.log(`  ${manifest.name} [${manifest.type}] v${manifest.version} — ${entry.description ?? entry.path}`);
    }
  }

  // Install each artifact
  const results: InstallResult[] = [];

  for (const { entry, manifest: artifactManifest } of artifactEntries) {
    // Check if this specific artifact is already installed
    const existing = getSkill(db, artifactManifest.name);
    if (existing && existing.status === "active") {
      if (!opts.yes) {
        console.log(`  ⏩ ${artifactManifest.name} already installed, skipping`);
      }
      results.push({
        success: true,
        name: artifactManifest.name,
        version: artifactManifest.version,
      });
      continue;
    }

    // The artifact's install path is the artifact subdirectory within the library clone
    const artifactInstallPath = join(installPath, entry.path);

    // Re-use the standard install flow for each artifact, pointing at the artifact subdir
    // We call install() recursively with libraryName set to track provenance
    const artifactResult = await installSingleArtifact(opts, artifactInstallPath, artifactManifest, libraryName);
    results.push(artifactResult);

    if (!artifactResult.success) {
      if (!opts.yes) {
        console.log(`  ❌ ${artifactManifest.name}: ${artifactResult.error}`);
      }
    } else if (!opts.yes) {
      console.log(`  ✅ ${artifactResult.name} v${artifactResult.version}`);
    }
  }

  const allSuccess = results.every((r) => r.success);
  const installedCount = results.filter((r) => r.success).length;

  return {
    success: allSuccess || installedCount > 0,
    name: libraryName,
    version: libraryManifest.version,
    manifest: libraryManifest,
    artifacts: results,
  };
}

/**
 * Install a single artifact from a library (or standalone).
 * The artifactDir is the resolved directory containing the artifact's manifest.
 */
async function installSingleArtifact(
  opts: InstallOptions,
  artifactDir: string,
  manifest: ArcManifest,
  libraryName: string,
): Promise<InstallResult> {
  const { paths, db, repoUrl } = opts;

  // Display capabilities per-artifact
  const risk = assessRisk(manifest);
  const capLines = formatCapabilities(manifest);

  if (!opts.yes) {
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";
    console.log(`\n  Install: ${manifest.name} v${manifest.version} [${manifest.type}]`);
    console.log(`  Risk: ${risk.toUpperCase()}`);
    if (tier !== "official" && capLines.length) {
      for (const line of capLines) {
        console.log(`  ${line}`);
      }
    }
  }

  // Run preinstall script
  if (manifest.scripts?.preinstall) {
    const preResult = runScript({
      installPath: artifactDir,
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

  // Create symlinks based on artifact type
  const artifactType = manifest.type as ArtifactType;

  if (artifactType === "rules") {
    const templates = manifest.provides?.templates ?? [];
    if (templates.length) {
      const consumerDir = opts.consumerDir ?? process.cwd();
      const results = await generateRules(artifactDir, templates, consumerDir);
      if (!opts.yes) {
        for (const r of results) {
          if (r.success && r.target) {
            console.log(`    Generated ${r.target}`);
          } else if (!r.success) {
            console.log(`    ⚠ ${r.target}: ${r.error}`);
          }
        }
      }
    }
  } else if (artifactType === "pipeline") {
    const pipelineSourceDir = join(artifactDir, "pipeline");
    const sourceDir = existsSync(pipelineSourceDir) ? pipelineSourceDir : artifactDir;
    await createSymlink(sourceDir, join(paths.pipelinesDir, manifest.name));
  } else if (artifactType === "component") {
    const files = manifest.provides?.files ?? [];
    for (const file of files) {
      const sourcePath = join(artifactDir, file.source);
      const targetPath = file.target.replace(/^~/, homedir());
      await mkdir(dirname(targetPath), { recursive: true });
      await createSymlink(sourcePath, targetPath);
    }
  } else if (artifactType === "tool") {
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      await createSymlink(artifactDir, join(paths.binDir, entry.binName));
    }
    if (!cliEntries.length) {
      await createSymlink(artifactDir, join(paths.binDir, manifest.name));
    }
    await createCliShim(paths.shimDir, paths.binDir, manifest);
  } else if (artifactType === "agent") {
    const agentSourceDir = join(artifactDir, "agent");
    const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : artifactDir;
    const mdFile = `${manifest.name}.md`;
    const sourcePath = join(sourceDir, mdFile);
    if (existsSync(sourcePath)) {
      await createSymlink(sourcePath, join(paths.agentsDir, mdFile));
    } else {
      await createSymlink(sourceDir, join(paths.agentsDir, manifest.name));
    }
  } else if (artifactType === "prompt") {
    const promptSourceDir = join(artifactDir, "prompt");
    const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : artifactDir;
    const mdFile = `${manifest.name}.md`;
    const sourcePath = join(sourceDir, mdFile);
    if (existsSync(sourcePath)) {
      await createSymlink(sourcePath, join(paths.promptsDir, mdFile));
    } else {
      await createSymlink(sourceDir, join(paths.promptsDir, manifest.name));
    }
  } else {
    // skill
    const skillSourceDir = join(artifactDir, "skill");
    if (existsSync(skillSourceDir)) {
      await createSymlink(skillSourceDir, join(paths.skillsDir, manifest.name));
    } else {
      await createSymlink(artifactDir, join(paths.skillsDir, manifest.name));
    }
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      await createSymlink(artifactDir, join(paths.binDir, entry.binName));
    }
    if (cliEntries.length) {
      await createCliShim(paths.shimDir, paths.binDir, manifest);
    }
  }

  // Register hooks
  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    artifactDir,
    manifest.name,
  );
  if (resolvedHooks?.length) {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    await registerHooks(manifest.name, resolvedHooks, settingsPath);
  }

  // Run bun install if package.json exists in artifact dir
  const packageJsonPath = join(artifactDir, "package.json");
  if (existsSync(packageJsonPath)) {
    Bun.spawnSync(["bun", "install"], {
      cwd: artifactDir,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  // Run postinstall script
  if (manifest.scripts?.postinstall) {
    const postResult = runScript({
      installPath: artifactDir,
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

  // Resolve the skill_dir for DB recording
  const artifactSourceDir =
    artifactType === "rules" || artifactType === "component" || artifactType === "tool"
      ? artifactDir
      : artifactType === "pipeline"
        ? (existsSync(join(artifactDir, "pipeline")) ? join(artifactDir, "pipeline") : artifactDir)
        : artifactType === "agent"
          ? join(artifactDir, "agent")
          : artifactType === "prompt"
            ? join(artifactDir, "prompt")
            : join(artifactDir, "skill");

  const now = new Date().toISOString();
  recordInstall(
    db,
    {
      name: manifest.name,
      version: manifest.version,
      repo_url: repoUrl,
      install_path: artifactDir,
      skill_dir: existsSync(artifactSourceDir) ? artifactSourceDir : artifactDir,
      status: "active",
      artifact_type: artifactType,
      tier: opts.sourceTier ?? manifest.tier ?? "custom",
      customization_path: null,
      install_source: opts.sourceName ?? `library:${libraryName}`,
      library_name: libraryName,
      installed_at: now,
      updated_at: now,
    },
    manifest,
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
