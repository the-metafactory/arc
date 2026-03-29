import { existsSync } from "fs";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import type { PaiPaths, InstalledSkill, SourcesConfig } from "../types.js";
import type { Database } from "bun:sqlite";
import { listSkills, getSkill } from "../lib/db.js";
import { readManifest } from "../lib/manifest.js";
import { createSymlink } from "../lib/symlinks.js";
import { loadSources } from "../lib/sources.js";
import { findInAllSources } from "../lib/remote-registry.js";
import { runScript } from "../lib/scripts.js";
import { registerHooks, removeHooks } from "../lib/hooks.js";

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
 * Upgrade a single installed package.
 * Pulls latest from git, re-reads manifest, updates DB version.
 */
export async function upgradePackage(
  db: Database,
  paths: PaiPaths,
  name: string
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

  // git pull in the cloned repo
  const pullResult = Bun.spawnSync(["git", "pull", "--ff-only"], {
    cwd: installPath,
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
    return { success: false, name, oldVersion: skill.version, error: "No pai-manifest.yaml after pull" };
  }

  const oldVersion = skill.version;
  const newVersion = manifest.version;

  if (compareSemver(oldVersion, newVersion) >= 0) {
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
  if (manifest.provides?.hooks?.length) {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    await removeHooks(name, settingsPath);
    await registerHooks(name, manifest.provides.hooks, settingsPath);
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
 */
export async function upgradeAll(
  db: Database,
  paths: PaiPaths
): Promise<UpgradeResult[]> {
  const checks = await checkUpgrades(db, paths);
  const upgradable = checks.filter((c) => c.upgradable);
  const results: UpgradeResult[] = [];

  for (const check of upgradable) {
    const result = await upgradePackage(db, paths, check.name);
    results.push(result);
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
  lines.push("Run `pai-pkg upgrade` to upgrade all, or `pai-pkg upgrade <name>` for one.");

  return lines.join("\n");
}

export function formatUpgradeResults(results: UpgradeResult[]): string {
  if (!results.length) {
    return "Nothing to upgrade.";
  }

  const lines: string[] = [];

  for (const r of results) {
    if (r.success) {
      if (r.oldVersion === r.newVersion) {
        lines.push(`  ${r.name}: already at ${r.oldVersion}`);
      } else {
        lines.push(`  ${r.name}: ${r.oldVersion} → ${r.newVersion}`);
      }
    } else {
      lines.push(`  ${r.name}: failed — ${r.error}`);
    }
  }

  return lines.join("\n");
}
