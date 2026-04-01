import { symlink, unlink, readlink, lstat, mkdir, writeFile, chmod, rename } from "fs/promises";
import { join, dirname, basename } from "path";
import type { ArcManifest } from "../types.js";

/**
 * Create a symlink, ensuring the parent directory exists.
 * If a symlink already exists at the target, removes it first.
 */
export async function createSymlink(
  target: string,
  linkPath: string
): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });

  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await unlink(linkPath);
    } else if (stat.isDirectory()) {
      // Back up existing directory (e.g., manually-installed skill being replaced by arc)
      await rename(linkPath, linkPath + ".pre-arc");
    } else if (stat.isFile()) {
      await unlink(linkPath);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  await symlink(target, linkPath);
}

/**
 * Remove a symlink if it exists.
 * Returns true if removed, false if it didn't exist.
 */
export async function removeSymlink(linkPath: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await unlink(linkPath);
      return true;
    }
    return false;
  } catch (err: any) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Check if a symlink exists and points to a valid target.
 */
export async function isValidSymlink(linkPath: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;

    // Check if the target exists
    const target = await readlink(linkPath);
    try {
      await lstat(target);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Get the target of a symlink.
 */
export async function getSymlinkTarget(
  linkPath: string
): Promise<string | null> {
  try {
    return await readlink(linkPath);
  } catch {
    return null;
  }
}

/**
 * Extract the CLI bin name and script path from a manifest.
 * Returns null if no CLI is declared.
 *
 * Derivation order for bin name:
 * 1. provides.cli[N].name (explicit)
 * 2. Basename of the script in provides.cli[N].command (e.g., "bun src/ctx.ts" → "ctx")
 * 3. Skill name lowercased without underscore prefix
 */
export function extractCliInfo(
  manifest: ArcManifest
): { binName: string; scriptPath: string; command: string } | null {
  const all = extractAllCliInfo(manifest);
  return all.length > 0 ? all[0] : null;
}

/**
 * Extract ALL CLI bin names and script paths from a manifest.
 * Returns empty array if no CLI is declared.
 */
export function extractAllCliInfo(
  manifest: ArcManifest
): Array<{ binName: string; scriptPath: string; command: string }> {
  if (!manifest.provides?.cli?.length) return [];

  return manifest.provides.cli.map((cli) => {
    const command = cli.command;
    const scriptPath = command.replace(/^bun\s+/, "");
    const binName = cli.name ?? basename(scriptPath, ".ts");
    return { binName, scriptPath, command };
  });
}

/**
 * Create PATH-accessible bash shims for all CLI entries in a manifest.
 * For bun commands: cd into bin dir and exec bun run.
 * For non-bun commands: exec the script directly from the bin dir.
 */
export async function createCliShim(
  shimDir: string,
  binDir: string,
  manifest: ArcManifest
): Promise<string[]> {
  const entries = extractAllCliInfo(manifest);
  if (!entries.length) return [];

  await mkdir(shimDir, { recursive: true });

  const created: string[] = [];
  for (const info of entries) {
    const shimPath = join(shimDir, info.binName);
    const binPath = join(binDir, info.binName);

    const isBunCommand = info.command.startsWith("bun ");
    const content = isBunCommand
      ? `#!/bin/bash\ncd "${binPath}" && exec bun run ${info.scriptPath} "$@"\n`
      : `#!/bin/bash\ncd "${binPath}" && exec ./${info.command} "$@"\n`;

    await writeFile(shimPath, content, { mode: 0o755 });
    created.push(info.binName);
  }

  return created;
}

/**
 * Remove a CLI shim from the shim directory.
 */
export async function removeCliShim(
  shimDir: string,
  binName: string
): Promise<boolean> {
  const shimPath = join(shimDir, binName);
  try {
    await unlink(shimPath);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
