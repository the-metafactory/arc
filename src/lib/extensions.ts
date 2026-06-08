import { join } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { createSymlink, removeSymlink } from "./symlinks.js";
import type { ArcManifest } from "../types.js";
import { errorMessage } from "./errors.js";

/**
 * Wire extensions declared in a package manifest.
 *
 * Currently supports:
 *   - statusline: symlinks into ~/.claude/statusline.d/{name}.sh
 *
 * Called during install and upgrade.
 */
export async function wireExtensions(
  manifest: ArcManifest,
  installPath: string,
  claudeRoot: string,
): Promise<string[]> {
  const wired: string[] = [];

  if (manifest.extensions?.statusline?.length) {
    const statuslineDir = join(claudeRoot, "statusline.d");
    await mkdir(statuslineDir, { recursive: true });

    for (const ext of manifest.extensions.statusline) {
      const sourcePath = join(installPath, ext.source);
      if (!existsSync(sourcePath)) {
        console.warn(`  \u26A0 Extension source not found: ${ext.source}`);
        continue;
      }
      const linkPath = join(statuslineDir, `${ext.name}.sh`);
      await createSymlink(sourcePath, linkPath);
      wired.push(`statusline:${ext.name}`);
    }
  }

  return wired;
}

/**
 * Remove extensions for a package.
 *
 * Called during remove.
 */
export async function unwireExtensions(
  manifest: ArcManifest,
  claudeRoot: string,
): Promise<string[]> {
  const removed: string[] = [];

  if (manifest.extensions?.statusline?.length) {
    const statuslineDir = join(claudeRoot, "statusline.d");

    for (const ext of manifest.extensions.statusline) {
      const linkPath = join(statuslineDir, `${ext.name}.sh`);
      await removeSymlink(linkPath);
      removed.push(`statusline:${ext.name}`);
    }
  }

  return removed;
}

/**
 * Roll back extensions using the exact extension records returned by
 * wireExtensions(). This is used when install fails after extension wiring
 * but before the package database row is committed.
 */
export async function rollbackWiredExtensions(
  wired: string[],
  claudeRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const record of wired) {
    const [kind, name] = record.split(":", 2);
    if (kind !== "statusline" || !name) {
      warnings.push(`unknown extension record ${record}`);
      continue;
    }

    const linkPath = join(claudeRoot, "statusline.d", `${name}.sh`);
    try {
      const removed = await removeSymlink(linkPath);
      if (!removed && existsSync(linkPath)) {
        warnings.push(`failed to remove extension ${record}: ${linkPath} is not a symlink`);
      }
    } catch (err) {
      warnings.push(`failed to remove extension ${record}: ${errorMessage(err)}`);
    }
  }

  return warnings;
}
