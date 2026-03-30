import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { createSymlink, removeSymlink } from "./symlinks.js";
import type { ArcManifest, ExtensionEntry } from "../types.js";

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
