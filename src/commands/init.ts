import { dirname, join } from "path";
import { existsSync, lstatSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { scaffoldEntriesFor, type ArtifactInitType } from "./init-scaffold.js";
import { errorMessage, isErrno } from "../lib/errors.js";

// Re-exports keep the public surface stable for callers (cli.ts, tests)
// that imported from `./init.js` before the cycle-7 module split.
export type { ArtifactInitType, ScaffoldEntry } from "./init-scaffold.js";
export { scaffoldEntriesFor } from "./init-scaffold.js";
export type { ResolvedInitTarget } from "./init-resolve.js";
export { resolveInitTarget } from "./init-resolve.js";

export interface InitResult {
  success: boolean;
  path?: string;
  error?: string;
  files?: string[];
}

/**
 * Probe `targetDir` for a usable scaffold target. Returns an error
 * string when the directory is unusable (regular file, broken symlink,
 * permission denied); returns `null` when the directory exists and is
 * usable or when it doesn't exist (the caller mkdirs).
 *
 * Sage P148 cycles 2 / 3 / 5: three cases need slightly different
 * probes — `lstatSync` detects symlinks without following, then
 * `statSync` follows to distinguish symlink-to-dir (good) from
 * broken symlink (bad). A plain `existsSync` returns false for
 * broken symlinks and would fall through to `mkdir`, which throws
 * `EEXIST` mid-scaffold.
 */
function validateTargetDir(targetDir: string): string | null {
  let lstat;
  try {
    lstat = lstatSync(targetDir);
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return null; // doesn't exist — fine
    return `Cannot access ${targetDir}: ${errorMessage(err)}`;
  }
  if (lstat.isSymbolicLink()) {
    try {
      const resolved = statSync(targetDir);
      if (!resolved.isDirectory()) return `${targetDir} exists and is not a directory`;
      return null;
    } catch {
      return `${targetDir} is a broken symlink`;
    }
  }
  if (!lstat.isDirectory()) return `${targetDir} exists and is not a directory`;
  return null;
}

/**
 * Scaffold a new skill, tool, agent, or prompt repo directory.
 *
 * arc#107 — `targetDir` may already exist (init-in-place mode). The
 * function refuses if `arc-manifest.yaml` already lives there (the
 * "already an arc package" signal) OR if any other scaffold target
 * file already exists (prevents silent clobber of operator content);
 * unrelated files are left alone. When `targetDir` does not yet exist,
 * it is created recursively. Matches the ergonomics of `npm init` /
 * `cargo init` / `git init`.
 *
 * Implementation orchestrates three pure pieces split across sibling
 * modules: {@link validateTargetDir} (probe), {@link scaffoldEntriesFor}
 * (what to write), and a single write loop here. The entries array is
 * the sole source of truth for what `init()` creates — pre-flight
 * check, mkdir-of-parents, and the writes all iterate it.
 */
export async function init(
  targetDir: string,
  name: string,
  author?: string,
  type: ArtifactInitType = "skill"
): Promise<InitResult> {
  const targetError = validateTargetDir(targetDir);
  if (targetError) return { success: false, error: targetError };

  const entries = scaffoldEntriesFor(type, name, author);

  // Sage P148 cycle 3 security: pre-flight check ALL files the scaffold
  // will write. Refuse if any exist — arc never overwrites operator
  // content. `arc-manifest.yaml` gets a dedicated message because it's
  // the unambiguous "already an arc package" signal.
  for (const entry of entries) {
    const abs = join(targetDir, entry.path);
    if (existsSync(abs)) {
      if (entry.path === "arc-manifest.yaml") {
        return {
          success: false,
          error: `arc-manifest.yaml already exists in ${targetDir} — refusing to overwrite`,
        };
      }
      return {
        success: false,
        error: `Refusing to overwrite existing file: ${abs}`,
      };
    }
  }

  // Create targetDir + every parent implied by entry paths in one pass.
  await mkdir(targetDir, { recursive: true });
  const parentDirs = new Set<string>();
  for (const entry of entries) {
    const dir = dirname(entry.path);
    if (dir !== "." && dir !== "") parentDirs.add(dir);
  }
  for (const dir of parentDirs) {
    await mkdir(join(targetDir, dir), { recursive: true });
  }

  // Write every entry. `files` mirrors entries by construction — no
  // separate `files.push` calls to forget.
  const files: string[] = [];
  for (const entry of entries) {
    await Bun.write(join(targetDir, entry.path), entry.content);
    files.push(entry.path);
  }

  return {
    success: true,
    path: targetDir,
    files,
  };
}
