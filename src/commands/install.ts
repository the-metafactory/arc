import { join } from "path";
import { existsSync } from "fs";
import type { PaiPaths, ArcManifest, ArtifactType, PackageTier } from "../types.js";
import type { Database } from "bun:sqlite";
import { readManifest, readLibraryArtifacts, assessRisk, formatCapabilities } from "../lib/manifest.js";
import { recordInstall, getSkill } from "../lib/db.js";
import { runScript } from "../lib/scripts.js";
import { registerHooks, resolveHooksFromManifest, findMissingHookFiles } from "../lib/hooks.js";
import { createArtifactSymlinks, resolveArtifactSourceDir, installNodeDependencies } from "../lib/artifact-installer.js";
import { wireExtensions } from "../lib/extensions.js";
import { extractRepoName } from "../lib/repo-name.js";

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
  /**
   * Pre-extracted install path (for registry installs from F-4).
   * When provided, skips git clone and uses this directory as the source.
   */
  preExtractedPath?: string;
  /** Pinned version — checkout this git tag after clone (e.g., "1.2.0" tries v1.2.0 then 1.2.0) */
  pinnedVersion?: string;
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

  // 1. Clone repo (or use pre-extracted path for registry installs)
  const repoName = opts.preExtractedPath
    ? opts.preExtractedPath.split("/").pop() ?? extractRepoName(repoUrl)
    : extractRepoName(repoUrl);
  const installPath = opts.preExtractedPath ?? join(paths.reposDir, repoName);

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

    // Skip stale-clone cleanup for registry installs (preExtractedPath) —
    // the directory was just extracted and its name (scope__name) won't match
    // the repo_url format (@scope/name@version).
    if (existsSync(installPath) && !opts.preExtractedPath) {
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

  // Only clone if not already present and no pre-extracted path (registry installs skip git)
  if (!existsSync(installPath) && !opts.preExtractedPath) {
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

    // Checkout pinned version tag if specified
    if (opts.pinnedVersion) {
      const checkoutResult = checkoutVersionTag(installPath, opts.pinnedVersion);
      if (!checkoutResult.success) {
        Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
        return { success: false, error: checkoutResult.error! };
      }
    }
  }

  // 2. Read manifest
  let manifest: ArcManifest | null = null;
  try {
    manifest = await readManifest(installPath);
  } catch (err: any) {
    Bun.spawnSync(["rm", "-rf", installPath]);
    return {
      success: false,
      error: `Failed to read manifest in ${repoUrl}: ${err.message}`,
    };
  }
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
  const symlinkResult = await createArtifactSymlinks({
    type: manifest.type,
    manifest,
    paths,
    installDir: installPath,
    consumerDir: opts.consumerDir,
    quiet: opts.yes,
  });
  if (symlinkResult.filesMissingSource.length) {
    const detail = symlinkResult.filesMissingSource
      .map((f) => `  - ${f.source} -> ${f.target}`)
      .join("\n");
    return {
      success: false,
      error:
        `Manifest declares provides.files entries whose source does not exist in the package:\n${detail}`,
    };
  }

  // 5b. Register hooks (if declared, with consent gating)
  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    installPath,
    manifest.name,
  );
  if (resolvedHooks?.length) {
    // Refuse to register hooks whose command points at a file that does not
    // exist \u2014 silent registration of broken hooks was the original symptom of
    // issue #84.
    const missingHookFiles = findMissingHookFiles(resolvedHooks);
    if (missingHookFiles.length) {
      const detail = missingHookFiles
        .map((m) => `  - ${m.event}: ${m.command}\n      missing: ${m.missingPath}`)
        .join("\n");
      return {
        success: false,
        error:
          `Manifest declares hooks whose command references a file that was not installed:\n${detail}\n` +
          `Add the file to provides.files (or fix the command path) and reinstall.`,
      };
    }
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";
    const approved = await promptHookConsent(
      manifest.name,
      tier,
      resolvedHooks,
      opts.yes,
    );
    if (approved) {
      const settingsPath = paths.settingsPath;
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

  // 5c. Wire extensions (if declared)
  if (manifest.extensions) {
    const wired = await wireExtensions(manifest, installPath, paths.claudeRoot);
    if (wired.length && !opts.yes) {
      for (const ext of wired) {
        console.log(`  \u2713 Extension wired: ${ext}`);
      }
    }
  }

  // 6. Run bun install if package.json exists
  installNodeDependencies(installPath);

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
  const artifactType = manifest.type as ArtifactType;
  const artifactSourceDir = resolveArtifactSourceDir(manifest.type, installPath);
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
export async function installSingleArtifact(
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

  const symlinkResult = await createArtifactSymlinks({
    type: artifactType,
    manifest,
    paths,
    installDir: artifactDir,
    consumerDir: opts.consumerDir,
    quiet: opts.yes,
  });
  if (symlinkResult.filesMissingSource.length) {
    const detail = symlinkResult.filesMissingSource
      .map((f) => `  - ${f.source} -> ${f.target}`)
      .join("\n");
    return {
      success: false,
      error:
        `Manifest declares provides.files entries whose source does not exist in the package:\n${detail}`,
    };
  }

  // Register hooks (with consent gating — same as standalone install)
  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    artifactDir,
    manifest.name,
  );
  if (resolvedHooks?.length) {
    // Refuse to register hooks whose command points at a file that does not
    // exist \u2014 silent registration of broken hooks was the original symptom of
    // issue #84.
    const missingHookFiles = findMissingHookFiles(resolvedHooks);
    if (missingHookFiles.length) {
      const detail = missingHookFiles
        .map((m) => `  - ${m.event}: ${m.command}\n      missing: ${m.missingPath}`)
        .join("\n");
      return {
        success: false,
        error:
          `Manifest declares hooks whose command references a file that was not installed:\n${detail}\n` +
          `Add the file to provides.files (or fix the command path) and reinstall.`,
      };
    }
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";
    const approved = await promptHookConsent(
      manifest.name,
      tier,
      resolvedHooks,
      opts.yes,
    );
    if (approved) {
      const settingsPath = paths.settingsPath;
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

  // Run bun install if package.json exists in artifact dir
  installNodeDependencies(artifactDir);

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
  const artifactSourceDir = resolveArtifactSourceDir(artifactType, artifactDir);

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
 * Parse a version suffix from a name-based install input.
 * e.g., "MySkill@1.2.0" → { name: "MySkill", version: "1.2.0" }
 * Returns null if no @ version suffix is present.
 */
export function parseNameVersion(input: string): { name: string; version: string } | null {
  // Don't parse URLs (contain ://) or scoped refs (@scope/name)
  if (input.includes("://") || input.startsWith("@") || input.startsWith("git@")) return null;

  const atIndex = input.lastIndexOf("@");
  if (atIndex <= 0) return null;

  const name = input.slice(0, atIndex);
  const version = input.slice(atIndex + 1);

  // Validate version looks like semver (digits and dots, with optional v prefix)
  if (!/^v?\d+\.\d+/.test(version)) return null;

  return { name, version: version.replace(/^v/, "") };
}

/**
 * Checkout a version tag in a cloned git repo.
 * Tries "v{version}" first, then "{version}" as a tag name.
 */
function checkoutVersionTag(
  repoPath: string,
  version: string,
): { success: boolean; tag?: string; error?: string } {
  // Try v-prefixed tag first (most common: v1.2.0)
  const vTag = version.startsWith("v") ? version : `v${version}`;
  const plainTag = version.startsWith("v") ? version.slice(1) : version;

  for (const tag of [vTag, plainTag]) {
    const result = Bun.spawnSync(
      ["git", "checkout", tag],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode === 0) {
      return { success: true, tag };
    }
  }

  // List available tags for a helpful error
  const tagList = Bun.spawnSync(
    ["git", "tag", "--list", "--sort=-v:refname"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const tags = tagList.stdout.toString().trim().split("\n").filter(Boolean).slice(0, 5);
  const available = tags.length ? ` Available: ${tags.join(", ")}` : "";

  return {
    success: false,
    error: `Version ${version} not found (tried tags ${vTag}, ${plainTag}).${available}`,
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
 * Returns empty string immediately if stdin is not a TTY (defense in depth).
 */
function readLine(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve("");
  }
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
