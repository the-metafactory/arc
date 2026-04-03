import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type { PaiPaths, InstalledSkill, SourcesConfig, RulesTemplate } from "../types.js";
import type { Database } from "bun:sqlite";
import { listSkills, getSkill, listByLibrary } from "../lib/db.js";
import { readManifest } from "../lib/manifest.js";
import { createSymlink } from "../lib/symlinks.js";
import { findGitRoot } from "../lib/paths.js";
import { loadSources } from "../lib/sources.js";
import { findInAllSources } from "../lib/remote-registry.js";
import { runScript } from "../lib/scripts.js";
import { registerHooks, removeHooks, resolveHooksFromManifest } from "../lib/hooks.js";
import { generateRules } from "../lib/rules.js";
import { wireExtensions } from "../lib/extensions.js";

export interface UpgradeCheckResult {
  name: string;
  installedVersion: string;
  registryVersion: string | null;
  repoVersion: string | null;
  upgradable: boolean;
}

export interface UpgradeResult {
  success: boolean;
  name: string;
  oldVersion: string;
  newVersion?: string;
  error?: string;
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Check which installed packages have newer versions available.
 */
export async function checkUpgrades(
  db: Database,
  paths: PaiPaths
): Promise<UpgradeCheckResult[]> {
  const installed = listSkills(db).filter((s) => s.status === "active");
  const sources = await loadSources(paths.sourcesPath);
  const results: UpgradeCheckResult[] = [];

  for (const skill of installed) {
    const result: UpgradeCheckResult = {
      name: skill.name,
      installedVersion: skill.version,
      registryVersion: null,
      repoVersion: null,
      upgradable: false,
    };

    // Check registry for advertised version
    const found = await findInAllSources(sources, skill.name, paths.cachePath);
    if (found?.entry.version) {
      result.registryVersion = found.entry.version;
    }

    // Check the actual cloned repo's manifest for current version
    if (existsSync(skill.install_path)) {
      const manifest = await readManifest(skill.install_path);
      if (manifest) {
        result.repoVersion = manifest.version;
      }
    }

    // Determine if upgrade is available
    // Priority: registry version (remote truth) > repo version (local clone)
    const availableVersion = result.registryVersion ?? result.repoVersion;
    if (availableVersion && compareSemver(skill.version, availableVersion) < 0) {
      result.upgradable = true;
    }

    results.push(result);
  }

  return results;
}

/**
 * Find all repos that have a matching config file for a rules template.
 * Scans ~/Developer/* for repos with the config file (e.g., agents-md.yaml).
 */
function findConsumerRepos(templates: RulesTemplate[]): string[] {
  const configFiles = templates.map((t) => t.config);
  const devRoot = process.env.BLUEPRINT_DEV_ROOT ?? join(homedir(), "Developer");
  const dirs: string[] = [];

  try {
    const entries = readdirSync(devRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoDir = join(devRoot, entry.name);
      for (const config of configFiles) {
        if (existsSync(join(repoDir, config))) {
          dirs.push(repoDir);
          break;
        }
      }
    }
  } catch (_err: unknown) {
    // Dev root doesn't exist or can't be read — fall back to cwd
  }

  // Always include cwd if it has a config and isn't already in the list
  const cwd = process.cwd();
  for (const config of configFiles) {
    if (existsSync(join(cwd, config)) && !dirs.includes(cwd)) {
      dirs.push(cwd);
      break;
    }
  }

  return dirs;
}

/**
 * Upgrade a single installed package.
 * Pulls latest from git, re-reads manifest, updates DB version.
 */
export async function upgradePackage(
  db: Database,
  paths: PaiPaths,
  name: string,
  opts?: { force?: boolean }
): Promise<UpgradeResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, name, oldVersion: "?", error: `"${name}" is not installed` };
  }
  if (skill.status !== "active") {
    return { success: false, name, oldVersion: skill.version, error: `"${name}" is disabled — enable it first` };
  }

  const installPath = skill.install_path;
  if (!existsSync(installPath)) {
    return { success: false, name, oldVersion: skill.version, error: `Install path not found: ${installPath}` };
  }

  // For library artifacts, git pull must run at the repo root (not artifact subdir)
  const gitCwd = findGitRoot(installPath) ?? installPath;

  // git pull in the cloned repo
  const pullResult = Bun.spawnSync(["git", "pull", "--ff-only"], {
    cwd: gitCwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (pullResult.exitCode !== 0) {
    const stderr = pullResult.stderr.toString().trim();
    return { success: false, name, oldVersion: skill.version, error: `git pull failed: ${stderr}` };
  }

  // Re-read manifest for new version
  const manifest = await readManifest(installPath);
  if (!manifest) {
    return { success: false, name, oldVersion: skill.version, error: "No arc-manifest.yaml (or pai-manifest.yaml) after pull" };
  }

  const oldVersion = skill.version;
  const newVersion = manifest.version;

  if (compareSemver(oldVersion, newVersion) >= 0 && !opts?.force) {
    // Version matches — but for rules packages, still regenerate templates
    // (template content may have changed even if version was already bumped)
    if (manifest.type === "rules" && manifest.provides?.templates?.length) {
      const consumerDirs = findConsumerRepos(manifest.provides.templates);
      for (const dir of consumerDirs) {
        await generateRules(installPath, manifest.provides.templates, dir);
      }
    }
    return { success: true, name, oldVersion, newVersion: oldVersion };
  }

  // Run preupgrade script if declared
  if (manifest.scripts?.preupgrade) {
    const preResult = runScript({
      installPath,
      scriptPath: manifest.scripts.preupgrade,
      hookName: "preupgrade",
      env: { PAI_OLD_VERSION: oldVersion, PAI_NEW_VERSION: newVersion },
    });
    if (!preResult.success && !preResult.skipped) {
      return { success: false, name, oldVersion, error: `Preupgrade script failed (exit ${preResult.exitCode})` };
    }
  }

  // Re-symlink component files if this is a component
  if (manifest.type === "component" && manifest.provides?.files?.length) {
    for (const file of manifest.provides.files) {
      const sourcePath = join(installPath, file.source);
      const targetPath = file.target.replace(/^~/, homedir());
      await mkdir(dirname(targetPath), { recursive: true });
      await createSymlink(sourcePath, targetPath);
    }
  }

  // Run bun install if package.json exists (dependencies may have changed)
  const packageJsonPath = join(installPath, "package.json");
  if (existsSync(packageJsonPath)) {
    Bun.spawnSync(["bun", "install"], {
      cwd: installPath,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  // Re-register hooks (remove old, add new) — no consent prompt on upgrade
  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    installPath,
    name,
  );
  if (resolvedHooks?.length) {
    const settingsPath = paths.settingsPath;
    await removeHooks(name, settingsPath);
    await registerHooks(name, resolvedHooks, settingsPath);
  }

  // Re-generate rules templates if this is a rules package
  // Scan all repos with matching config files, not just cwd
  if (manifest.type === "rules" && manifest.provides?.templates?.length) {
    const consumerDirs = findConsumerRepos(manifest.provides.templates);
    for (const dir of consumerDirs) {
      await generateRules(installPath, manifest.provides.templates, dir);
    }
  }

  // Re-wire extensions (if declared)
  if (manifest.extensions) {
    const wired = await wireExtensions(manifest, installPath, paths.claudeRoot);
    for (const ext of wired) {
      console.log(`  \u2713 Extension wired: ${ext}`);
    }
  }

  // Run postupgrade script if declared (falls back to postinstall)
  const postHook = manifest.scripts?.postupgrade ?? manifest.scripts?.postinstall;
  const postHookName = manifest.scripts?.postupgrade ? "postupgrade" : "postinstall";
  if (postHook) {
    const postResult = runScript({
      installPath,
      scriptPath: postHook,
      hookName: postHookName,
      env: { PAI_OLD_VERSION: oldVersion, PAI_NEW_VERSION: newVersion },
    });
    if (!postResult.success && !postResult.skipped) {
      return { success: false, name, oldVersion, error: `${postHookName} script failed (exit ${postResult.exitCode})` };
    }
  }

  // Update DB
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE skills SET version = ?, updated_at = ? WHERE name = ?"
  ).run(newVersion, now, name);

  // Update capabilities — delete old, re-insert from new manifest
  db.prepare("DELETE FROM capabilities WHERE skill_name = ?").run(name);

  const insertCap = db.prepare(
    "INSERT INTO capabilities (skill_name, type, value, reason) VALUES (?, ?, ?, ?)"
  );
  const caps = manifest.capabilities;
  if (caps) {
    if (caps.filesystem?.read) {
      for (const p of caps.filesystem.read) insertCap.run(name, "fs_read", p, "");
    }
    if (caps.filesystem?.write) {
      for (const p of caps.filesystem.write) insertCap.run(name, "fs_write", p, "");
    }
    if (caps.network) {
      for (const n of caps.network) insertCap.run(name, "network", n.domain, n.reason);
    }
    if (caps.bash?.restricted_to) {
      for (const b of caps.bash.restricted_to) insertCap.run(name, "bash", b, "");
    }
    if (caps.secrets) {
      for (const s of caps.secrets) insertCap.run(name, "secret", s, "");
    }
  }

  return { success: true, name, oldVersion, newVersion };
}

/**
 * Upgrade all installed packages that have newer versions.
 * When force=true, skips the expensive checkUpgrades (git fetch + registry
 * lookup per package) and instead gets all active packages directly from the DB.
 */
export async function upgradeAll(
  db: Database,
  paths: PaiPaths,
  opts?: { force?: boolean }
): Promise<UpgradeResult[]> {
  const results: UpgradeResult[] = [];

  if (opts?.force) {
    // Skip checkUpgrades entirely — just get all active packages from DB
    const active = listSkills(db).filter((s) => s.status === "active");
    for (const pkg of active) {
      const result = await upgradePackage(db, paths, pkg.name, opts);
      results.push(result);
    }
  } else {
    const checks = await checkUpgrades(db, paths);
    const upgradable = checks.filter((c) => c.upgradable);
    for (const check of upgradable) {
      const result = await upgradePackage(db, paths, check.name);
      results.push(result);
    }
  }

  return results;
}

export function formatCheckResults(results: UpgradeCheckResult[]): string {
  const upgradable = results.filter((r) => r.upgradable);

  if (!upgradable.length) {
    return "All packages are up to date.";
  }

  const lines: string[] = [
    `${upgradable.length} package(s) can be upgraded:`,
    "",
  ];

  for (const r of upgradable) {
    const target = r.registryVersion ?? r.repoVersion ?? "?";
    lines.push(`  ${r.name}: ${r.installedVersion} → ${target}`);
  }

  lines.push("");
  lines.push("Run `arc upgrade` to upgrade all, or `arc upgrade <name>` for one.");

  return lines.join("\n");
}

export function formatUpgradeResults(results: UpgradeResult[], opts?: { force?: boolean }): string {
  if (!results.length) {
    return "Nothing to upgrade.";
  }

  const lines: string[] = [];

  for (const r of results) {
    if (r.success) {
      if (r.oldVersion === r.newVersion) {
        if (opts?.force) {
          lines.push(`  ${r.name}: force-upgraded at ${r.oldVersion}`);
        } else {
          lines.push(`  ${r.name}: already at ${r.oldVersion}`);
        }
      } else {
        lines.push(`  ${r.name}: ${r.oldVersion} → ${r.newVersion}`);
      }
    } else {
      lines.push(`  ${r.name}: failed — ${r.error}`);
    }
  }

  return lines.join("\n");
}

/**
 * Upgrade all artifacts from a library.
 * Pulls the repo once, then checks each artifact's manifest version.
 */
export async function upgradeLibrary(
  db: Database,
  paths: PaiPaths,
  libraryName: string,
  opts?: { force?: boolean }
): Promise<UpgradeResult[]> {
  const artifacts = listByLibrary(db, libraryName);
  if (!artifacts.length) {
    return [{ success: false, name: libraryName, oldVersion: "?", error: `No artifacts installed from library '${libraryName}'` }];
  }

  // Pull the library repo once (from the first artifact's path)
  const gitRoot = findGitRoot(artifacts[0].install_path);
  if (gitRoot) {
    const pullResult = Bun.spawnSync(["git", "pull", "--ff-only"], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pullResult.exitCode !== 0) {
      return [{ success: false, name: libraryName, oldVersion: "?", error: `git pull failed: ${pullResult.stderr.toString().trim()}` }];
    }
  }

  // Upgrade each artifact via upgradePackage (git pull is a no-op since we already pulled).
  // This ensures per-artifact scripts, hooks, capabilities, and symlinks are all handled.
  const results: UpgradeResult[] = [];
  for (const artifact of artifacts) {
    const result = await upgradePackage(db, paths, artifact.name, opts);
    results.push(result);
  }

  return results;
}
