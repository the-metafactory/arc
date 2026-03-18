import { symlink, unlink, readlink, lstat, mkdir } from "fs/promises";
import { join, dirname } from "path";

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
