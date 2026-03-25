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

export function formatSelfUpdate(result: SelfUpdateResult): string {
  if (!result.success) {
    return `Self-update failed: ${result.error}`;
  }

  if (result.oldVersion === result.newVersion) {
    return `pai-pkg is already up to date (v${result.newVersion}).`;
  }

  return `pai-pkg updated: v${result.oldVersion} → v${result.newVersion}`;
}
