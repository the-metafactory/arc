import { join } from "path";

export interface SelfUpdateResult {
  success: boolean;
  oldVersion: string;
  newVersion: string;
  error?: string;
}

/**
 * Update pai-pkg itself by pulling latest from git and reinstalling deps.
 */
export async function selfUpdate(): Promise<SelfUpdateResult> {
  // This file is at src/commands/self-update.ts — root is two levels up
  const pkgRoot = join(import.meta.dir, "..", "..");
  const pkgJsonPath = join(pkgRoot, "package.json");

  // Read current version
  let oldVersion: string;
  try {
    const pkg = await Bun.file(pkgJsonPath).json();
    oldVersion = pkg.version;
  } catch {
    return { success: false, oldVersion: "unknown", newVersion: "unknown", error: "Could not read package.json" };
  }

  // git pull --ff-only
  const pull = Bun.spawnSync(["git", "pull", "--ff-only"], {
    cwd: pkgRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (pull.exitCode !== 0) {
    const stderr = pull.stderr.toString().trim();
    return {
      success: false,
      oldVersion,
      newVersion: oldVersion,
      error: `git pull failed: ${stderr}`,
    };
  }

  // bun install (in case deps changed)
  const install = Bun.spawnSync(["bun", "install"], {
    cwd: pkgRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (install.exitCode !== 0) {
    const stderr = install.stderr.toString().trim();
    return {
      success: false,
      oldVersion,
      newVersion: oldVersion,
      error: `bun install failed: ${stderr}`,
    };
  }

  // Read new version
  let newVersion: string;
  try {
    // Re-read from disk (not cached)
    const raw = await Bun.file(pkgJsonPath).text();
    const pkg = JSON.parse(raw);
    newVersion = pkg.version;
  } catch {
    newVersion = oldVersion;
  }

  return { success: true, oldVersion, newVersion };
}

export interface SelfUpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

/**
 * Check if a newer version of pai-pkg is available.
 * Compares local package.json against the latest GitHub Release tag.
 */
export function checkSelfUpdate(): SelfUpdateCheck {
  const pkgRoot = join(import.meta.dir, "..", "..");
  const pkgJsonPath = join(pkgRoot, "package.json");

  let currentVersion: string;
  try {
    const raw = require(pkgJsonPath);
    currentVersion = raw.version;
  } catch {
    return { currentVersion: "unknown", latestVersion: null, updateAvailable: false };
  }

  // Check latest release tag via gh CLI
  try {
    const result = Bun.spawnSync(
      ["gh", "release", "view", "--repo", "mellanon/pai-pkg", "--json", "tagName", "--jq", ".tagName"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 }
    );
    if (result.exitCode === 0) {
      const tag = result.stdout.toString().trim().replace(/^v/, "");
      if (tag) {
        const pa = currentVersion.split(".").map(Number);
        const pb = tag.split(".").map(Number);
        let newer = false;
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) < (pb[i] ?? 0)) { newer = true; break; }
          if ((pa[i] ?? 0) > (pb[i] ?? 0)) break;
        }
        return { currentVersion, latestVersion: tag, updateAvailable: newer };
      }
    }
  } catch {
    // gh not available — skip
  }

  // Fallback: check if local git has newer commits on remote
  try {
    Bun.spawnSync(["git", "fetch", "--quiet"], {
      cwd: pkgRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const result = Bun.spawnSync(
      ["git", "rev-list", "HEAD..@{u}", "--count"],
      { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode === 0) {
      const count = parseInt(result.stdout.toString().trim(), 10);
      if (count > 0) {
        return { currentVersion, latestVersion: null, updateAvailable: true };
      }
    }
  } catch {
    // git not available or no remote — skip
  }

  return { currentVersion, latestVersion: null, updateAvailable: false };
}

export function formatSelfUpdateCheck(check: SelfUpdateCheck): string {
  if (!check.updateAvailable) return "";
  if (check.latestVersion) {
    return `pai-pkg update available: v${check.currentVersion} → v${check.latestVersion} (run \`pai-pkg self-update\`)`;
  }
  return `pai-pkg update available (run \`pai-pkg self-update\`)`;
}

export function formatSelfUpdate(result: SelfUpdateResult): string {
  if (!result.success) {
    return `Self-update failed: ${result.error}`;
  }

  if (result.oldVersion === result.newVersion) {
    return `pai-pkg is already up to date (v${result.newVersion}).`;
  }

  return `pai-pkg updated: v${result.oldVersion} → v${result.newVersion}`;
}
