import type { ArcManifest } from "../types.js";
import { resolveArtifactSourceDir } from "./artifact-installer.js";
import { errorMessage } from "./errors.js";

export type SomaSkillProjectionMode = "project" | "unproject";

export interface SomaSkillProjectionResult {
  attempted: boolean;
  success: boolean;
  skipped: boolean;
  warning?: string;
}

export interface SomaSkillProjectionOptions {
  manifest: ArcManifest;
  installPath: string;
  mode: SomaSkillProjectionMode;
  quiet?: boolean;
}

/**
 * Delegate skill loader/catalog projection to Soma.
 *
 * This is intentionally a narrow process boundary: Arc owns package landing,
 * Soma owns multi-substrate projection. Missing or failing Soma never aborts
 * the Arc lifecycle; the Claude-Code symlink remains the local fallback.
 */
export function runSomaSkillProjection(
  opts: SomaSkillProjectionOptions,
): SomaSkillProjectionResult {
  if (opts.manifest.type !== "skill") {
    return { attempted: false, success: true, skipped: true };
  }

  const skillDir = resolveArtifactSourceDir(opts.manifest.type, opts.installPath);
  const command = opts.mode === "project" ? "project-skill" : "unproject-skill";
  const somaBin = process.env.ARC_SOMA_BIN;
  if (!somaBin && process.env.NODE_ENV === "test") {
    return { attempted: false, success: true, skipped: true };
  }

  try {
    const result = Bun.spawnSync([somaBin ?? "soma", command, skillDir, "--apply"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode === 0) {
      return { attempted: true, success: true, skipped: false };
    }

    const stderr = result.stderr.toString().trim();
    return warnAndSkip(
      `soma ${command} failed for ${opts.manifest.name}${stderr ? `: ${stderr}` : ""}`,
      opts.quiet,
    );
  } catch (err) {
    return warnAndSkip(
      `soma ${command} unavailable for ${opts.manifest.name}: ${errorMessage(err)}`,
      opts.quiet,
    );
  }
}

function warnAndSkip(message: string, quiet?: boolean): SomaSkillProjectionResult {
  if (!quiet) {
    process.stderr.write(`  ⚠ ${message}; continuing without Soma projection\n`);
  }
  return {
    attempted: true,
    success: false,
    skipped: true,
    warning: message,
  };
}
