/**
 * Lifecycle script runner for arc.
 *
 * Executes manifest-declared scripts (preinstall, postinstall, preupgrade, postupgrade)
 * with standardized env vars and error handling.
 */

import { existsSync } from "fs";
import { join } from "path";

export interface RunScriptOpts {
  /** Absolute path to the installed repo */
  installPath: string;
  /** Relative script path from manifest (e.g. "./scripts/postinstall.sh") */
  scriptPath: string;
  /** Hook name for logging (e.g. "postinstall", "preupgrade") */
  hookName: string;
  /** Suppress console output (for non-interactive / test use) */
  quiet?: boolean;
  /** Extra env vars to pass to the script */
  env?: Record<string, string>;
}

export interface RunScriptResult {
  success: boolean;
  hookName: string;
  exitCode: number | null;
  skipped?: boolean;
}

/**
 * Run a lifecycle script declared in pai-manifest.yaml.
 *
 * Returns { success: true, skipped: true } if the script file doesn't exist on disk.
 * Returns { success: false } if the script exits non-zero.
 */
export function runScript(opts: RunScriptOpts): RunScriptResult {
  const absPath = join(opts.installPath, opts.scriptPath);

  if (!existsSync(absPath)) {
    return { success: true, hookName: opts.hookName, exitCode: null, skipped: true };
  }

  if (!opts.quiet) {
    console.log(`\nRunning ${opts.hookName}: ${opts.scriptPath}`);
  }

  const result = Bun.spawnSync(["bash", absPath], {
    cwd: opts.installPath,
    stdout: opts.quiet ? "pipe" : "inherit",
    stderr: opts.quiet ? "pipe" : "inherit",
    env: {
      ...process.env,
      PAI_INSTALL_PATH: opts.installPath,
      PAI_HOOK: opts.hookName,
      ...opts.env,
    },
  });

  return {
    success: result.exitCode === 0,
    hookName: opts.hookName,
    exitCode: result.exitCode,
  };
}
