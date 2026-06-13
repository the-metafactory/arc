import { symlink, unlink, readlink, lstat, mkdir, writeFile, rename } from "fs/promises";
import { join, dirname, basename } from "path";
import type { ArcManifest } from "../types.js";
import { isErrno } from "./errors.js";

/**
 * Thrown by {@link createSymlink} (arc#163) when a regular file already
 * occupies the link target. Distinct from `ErrnoException` so callers can
 * `instanceof`-discriminate to print a friendly hint without grep-matching
 * the message.
 */
export class SymlinkConflictError extends Error {
  readonly code = "ARC_SYMLINK_CONFLICT" as const;
  readonly linkPath: string;
  constructor(linkPath: string) {
    super(
      `Refusing to symlink over existing regular file at ${linkPath}. ` +
        `Move or delete this file manually, then re-run the install.`,
    );
    this.name = "SymlinkConflictError";
    this.linkPath = linkPath;
  }
}

/**
 * Create a symlink, ensuring the parent directory exists.
 * If a symlink already exists at the target, removes it first. If a regular
 * file is in the way, refuses (arc#163) — uninstall treats non-symlinks as
 * operator-owned state, so install must too. Directories are renamed aside
 * (`.pre-arc`) so a manually-installed skill being replaced by arc isn't
 * destroyed silently.
 *
 * Throws {@link SymlinkConflictError} on regular-file conflict.
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
      throw new SymlinkConflictError(linkPath);
    }
  } catch (err) {
    if (!isErrno(err) || err.code !== "ENOENT") throw err;
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
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return false;
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
): { binName: string; scriptPath: string; command: string }[] {
  if (!manifest.provides?.cli?.length) return [];

  return manifest.provides.cli.map((cli) => {
    const command = cli.command;
    const scriptPath = command.replace(/^bun\s+/, "");
    const binName = cli.name ?? basename(scriptPath, ".ts");
    return { binName, scriptPath, command };
  });
}

/**
 * Filesystem name of a CLI shim. On Windows, PATH execution is driven by file
 * extension (PATHEXT) — an extensionless `#!/bin/bash` script is not runnable —
 * so shims get a `.cmd` suffix there. POSIX shims stay extensionless.
 */
function shimFileName(binName: string, platform: string): string {
  return platform === "win32" ? `${binName}.cmd` : binName;
}

/**
 * Build the contents of a CLI shim for the target platform.
 *
 * POSIX: a `#!/bin/bash` script that `cd`s into the bin dir and execs the CLI.
 * Windows: a `.cmd` launcher that does the same with `cd /d` (so it follows the
 * bin symlink and switches drive if needed) and forwards args via `%*`. cmd.exe
 * can't run the bash shim because PATHEXT has no entry for extensionless files.
 *
 * For bun commands (`command` starts with `bun `) the shim runs `bun run
 * <script>`. Non-bun commands are invoked explicitly relative to the bin dir
 * on both platforms (`./` / `.\`), never via PATH lookup — a bare name would
 * let a same-named program elsewhere on PATH shadow the installed one. On
 * Windows this is still best-effort, since arbitrary POSIX entrypoints (e.g.
 * a `.sh`) aren't natively runnable there — but nearly all arc CLIs are bun.
 */
function buildShimContent(
  info: { scriptPath: string; command: string },
  binPath: string,
  platform: string
): string {
  const isBunCommand = info.command.startsWith("bun ");

  if (platform === "win32") {
    const invoke = isBunCommand
      ? `bun run ${info.scriptPath}`
      : `.\\${info.command}`;
    // soma#315: capture the caller's cwd before `cd /d` so wrapped CLIs
    // can resolve relative path args against the user's shell dir, not
    // the bin dir. `if not defined` preserves an outer value across
    // nested arc CLI invocations.
    return `@echo off\r\nsetlocal\r\nif not defined ARC_INVOCATION_CWD set "ARC_INVOCATION_CWD=%CD%"\r\ncd /d "${binPath}" || exit /b 1\r\n${invoke} %*\r\n`;
  }

  const invoke = isBunCommand
    ? `exec bun run ${info.scriptPath}`
    : `exec ./${info.command}`;
  // soma#315: export the caller's working directory before the `cd` into
  // the bin dir. The `cd` overwrites both the process cwd and $PWD, so a
  // wrapped CLI cannot otherwise recover where the user invoked it from.
  // Capture via `pwd` (command substitution) rather than echoing the
  // inherited `$PWD`, so the value comes from the shell's own view of the
  // current directory instead of a variable a parent may have left stale.
  // `${ARC_INVOCATION_CWD:-…}` keeps an outer value when one arc CLI
  // shells out to another.
  return `#!/bin/bash\nexport ARC_INVOCATION_CWD="\${ARC_INVOCATION_CWD:-$(pwd)}"\ncd "${binPath}" && ${invoke} "$@"\n`;
}

/**
 * Create PATH-accessible shims for all CLI entries in a manifest.
 *
 * The shim flavor follows `platform` (defaults to the host, overridable for
 * tests — mirrors `detectPlatform` in cosign.ts): a `#!/bin/bash` script on
 * POSIX, a `.cmd` launcher on Windows. Returns the logical bin names created
 * (not the on-disk filenames), which is what the DB and {@link removeCliShim}
 * key on.
 */
export async function createCliShim(
  shimDir: string,
  binDir: string,
  manifest: ArcManifest,
  platform: string = process.platform
): Promise<string[]> {
  const entries = extractAllCliInfo(manifest);
  if (!entries.length) return [];

  await mkdir(shimDir, { recursive: true });

  const created: string[] = [];
  for (const info of entries) {
    const shimPath = join(shimDir, shimFileName(info.binName, platform));
    const binPath = join(binDir, info.binName);

    await writeFile(shimPath, buildShimContent(info, binPath, platform), {
      mode: 0o755,
    });
    created.push(info.binName);
  }

  return created;
}

/**
 * Remove a CLI shim from the shim directory.
 *
 * Removes the platform-native shim (`<bin>.cmd` on Windows, `<bin>` on POSIX).
 * On Windows it also sweeps a legacy extensionless shim left by older arc
 * versions, so `arc remove` never orphans the broken bash file. Returns true if
 * any shim was removed.
 */
export async function removeCliShim(
  shimDir: string,
  binName: string,
  platform: string = process.platform
): Promise<boolean> {
  const candidates = [shimFileName(binName, platform)];
  // win32: also sweep a pre-fix extensionless shim left by older arc versions.
  if (platform === "win32") candidates.push(binName);

  let removed = false;
  for (const name of candidates) {
    try {
      await unlink(join(shimDir, name));
      removed = true;
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return removed;
}
