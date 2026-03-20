import { symlink, unlink, readlink, lstat, mkdir, writeFile, chmod } from "fs/promises";
import { join, dirname, basename } from "path";
import type { PaiManifest } from "../types.js";

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
 * 1. provides.cli[0].name (explicit)
 * 2. Basename of the script in provides.cli[0].command (e.g., "bun src/ctx.ts" → "ctx")
 * 3. Skill name lowercased without underscore prefix
 */
export function extractCliInfo(
  manifest: PaiManifest
): { binName: string; scriptPath: string } | null {
  if (!manifest.provides?.cli?.length) return null;

  const cli = manifest.provides.cli[0];
  const command = cli.command;

  // Extract script path by stripping "bun " prefix
  const scriptPath = command.replace(/^bun\s+/, "");

  // Derive bin name
  const binName =
    cli.name ?? basename(scriptPath, ".ts");

  return { binName, scriptPath };
}

/**
 * Create a PATH-accessible bash shim for a skill CLI.
 * The shim cd's into the bin dir (which symlinks to the repo) and runs the entry point.
 */
export async function createCliShim(
  shimDir: string,
  binDir: string,
  manifest: PaiManifest
): Promise<string | null> {
  const info = extractCliInfo(manifest);
  if (!info) return null;

  const shimPath = join(shimDir, info.binName);
  const binPath = join(binDir, info.binName);

  const content = `#!/bin/bash\ncd "${binPath}" && exec bun run ${info.scriptPath} "$@"\n`;

  await mkdir(shimDir, { recursive: true });
  await writeFile(shimPath, content, { mode: 0o755 });

  return info.binName;
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
