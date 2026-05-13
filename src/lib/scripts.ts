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
 * Run a lifecycle script declared in arc-manifest.yaml.
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

export interface RunLifecycleOpts {
  /** Absolute path to the installed repo */
  installPath: string;
  /** Ordered array of script paths from manifest.lifecycle.<phase> */
  scriptPaths: string[];
  /** Phase name for logging ("preinstall", "postinstall", "preuninstall", "postuninstall") */
  phase: string;
  /** Suppress console output (for non-interactive / test use) */
  quiet?: boolean;
  /** Extra env vars to pass to each script */
  env?: Record<string, string>;
}

export interface RunLifecycleResult {
  /** True iff every script ran (or was missing) without a non-zero exit. */
  success: boolean;
  /** Phase name, echoed for caller convenience. */
  phase: string;
  /** Per-script results in declared order. Empty when scriptPaths is empty. */
  steps: Array<{
    scriptPath: string;
    exitCode: number | null;
    skipped: boolean;
  }>;
  /** The script that failed, if any — last entry of `steps` when !success. */
  failedAt?: string;
}

/**
 * Run a `manifest.lifecycle.<phase>` array of scripts in declared order.
 *
 * Lifecycle arrays exist for sequences where order matters — e.g. the
 * type:agent standalone-bot install sequence (cortex `docs/design-arc-agent-bots.md`
 * §8.1 / §8.2): signal-cortex-reload → issue-nats-creds → launchctl-load.
 * Each script is invoked via {@link runScript}, so per-script env injection
 * and missing-file handling stay consistent with the single-script
 * `manifest.scripts.<phase>` path.
 *
 * On first non-zero exit, the runner stops and returns `success: false`
 * with the failed script in `failedAt`. Earlier scripts are NOT re-run on
 * retry; callers wiring rollback should treat the partial side-effects of
 * earlier scripts as already-applied state to be reversed by the rollback
 * path.
 *
 * Empty array → `success: true, steps: []` (no-op).
 */
export function runLifecycleScripts(
  opts: RunLifecycleOpts,
): RunLifecycleResult {
  const steps: RunLifecycleResult["steps"] = [];

  for (const scriptPath of opts.scriptPaths) {
    const result = runScript({
      installPath: opts.installPath,
      scriptPath,
      hookName: opts.phase,
      quiet: opts.quiet,
      env: opts.env,
    });
    steps.push({
      scriptPath,
      exitCode: result.exitCode,
      skipped: result.skipped ?? false,
    });
    if (!result.success && !result.skipped) {
      return {
        success: false,
        phase: opts.phase,
        steps,
        failedAt: scriptPath,
      };
    }
  }

  return { success: true, phase: opts.phase, steps };
}
