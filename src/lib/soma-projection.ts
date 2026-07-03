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
}

/**
 * Delegate skill loader/catalog projection to Soma.
 *
 * This is intentionally a narrow process boundary: Arc owns package landing,
 * Soma owns multi-substrate projection. Missing or failing Soma never aborts
 * the Arc lifecycle; the Claude-Code symlink remains the local fallback.
 */
export async function runSomaSkillProjection(
  opts: SomaSkillProjectionOptions,
): Promise<SomaSkillProjectionResult> {
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
    const result = Bun.spawn([somaBin ?? "soma", command, skillDir, "--apply"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      result.exited,
      new Response(result.stderr).text(),
    ]);

    if (exitCode === 0) {
      return { attempted: true, success: true, skipped: false };
    }

    return skipWithWarning(
      `soma ${command} failed for ${opts.manifest.name}${stderr ? `: ${stderr}` : ""}`,
    );
  } catch (err) {
    return skipWithWarning(
      `soma ${command} unavailable for ${opts.manifest.name}: ${errorMessage(err)}`,
    );
  }
}

function skipWithWarning(message: string): SomaSkillProjectionResult {
  return {
    attempted: true,
    success: false,
    skipped: true,
    warning: message,
  };
}
