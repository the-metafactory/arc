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

const SOMA_STDERR_LIMIT_BYTES = 8192;

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
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      result.exited,
      readLimitedStderr(result.stderr, SOMA_STDERR_LIMIT_BYTES),
    ]);

    if (exitCode === 0) {
      return { attempted: true, success: true, skipped: false };
    }

    return failWithWarning(
      `soma ${command} failed for ${opts.manifest.name}${stderr ? `: ${stderr}` : ""}`,
    );
  } catch (err) {
    return skipWithWarning(
      `soma ${command} unavailable for ${opts.manifest.name}: ${errorMessage(err)}`,
    );
  }
}

export function writeSomaProjectionWarning(warning: string): void {
  process.stderr.write(`  ⚠ ${warning}; continuing without Soma projection\n`);
}

async function readLimitedStderr(
  stream: ReadableStream<Uint8Array> | null,
  limitBytes: number,
): Promise<string> {
  if (!stream || limitBytes <= 0) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (total < limitBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remaining = limitBytes - total;
      if (value.length > remaining) {
        chunks.push(value.slice(0, remaining));
        total = limitBytes;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      total += value.length;
    }

    if (total >= limitBytes && !truncated) {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        await reader.cancel();
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  const stderr = new TextDecoder().decode(buffer);
  return truncated
    ? `${stderr}\n[stderr truncated after ${limitBytes} bytes]`
    : stderr;
}

function skipWithWarning(message: string): SomaSkillProjectionResult {
  return {
    attempted: true,
    success: false,
    skipped: true,
    warning: message,
  };
}

function failWithWarning(message: string): SomaSkillProjectionResult {
  return {
    attempted: true,
    success: false,
    skipped: false,
    warning: message,
  };
}
