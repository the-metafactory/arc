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
const DEFAULT_SOMA_TIMEOUT_MS = 30_000;
const SOMA_KILL_GRACE_MS = 250;

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
    const timeoutMs = resolveSomaTimeoutMs();
    const abortController = new AbortController();
    const [exitResult, stderr] = await Promise.all([
      waitForSomaExit(result, timeoutMs, abortController),
      readLimitedStderr(result.stderr, SOMA_STDERR_LIMIT_BYTES, abortController.signal),
    ]);

    if (exitResult.timedOut) {
      return failWithWarning(
        `soma ${command} timed out after ${timeoutMs}ms for ${opts.manifest.name}${stderr ? `: ${stderr}` : ""}`,
      );
    }

    if (exitResult.exitCode === 0) {
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

function resolveSomaTimeoutMs(): number {
  const raw = process.env.ARC_SOMA_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_SOMA_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOMA_TIMEOUT_MS;
}

async function waitForSomaExit(
  process: Bun.Subprocess<"ignore", "ignore", "pipe">,
  timeoutMs: number,
  abortController: AbortController,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let graceTimeout: ReturnType<typeof setTimeout> | undefined;
  const state = { timedOut: false };

  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      state.timedOut = true;
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may already have exited.
      }
      graceTimeout = setTimeout(() => {
        try {
          process.kill("SIGKILL");
        } catch {
          // Process may already have exited.
        }
        abortController.abort();
        resolve("timeout");
      }, SOMA_KILL_GRACE_MS);
    }, timeoutMs);
  });

  const exited = process.exited.then((exitCode) => ({ exitCode }));
  const result = await Promise.race([exited, timeout]);

  if (typeof result === "string") {
    return { exitCode: null, timedOut: true };
  }

  if (state.timedOut) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (graceTimeout) {
      clearTimeout(graceTimeout);
    }
    abortController.abort();
    return { exitCode: result.exitCode, timedOut: true };
  }

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  if (graceTimeout) {
    clearTimeout(graceTimeout);
  }
  return { exitCode: result.exitCode, timedOut: false };
}

async function readLimitedStderr(
  stream: ReadableStream<Uint8Array> | null,
  limitBytes: number,
  abortSignal: AbortSignal,
): Promise<string> {
  if (!stream || limitBytes <= 0) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const abort = new Promise<"aborted">((resolve) => {
    if (abortSignal.aborted) {
      resolve("aborted");
      return;
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        resolve("aborted");
      },
      { once: true },
    );
  });

  try {
    while (total < limitBytes) {
      const read = await Promise.race([reader.read(), abort]);
      if (read === "aborted") {
        await reader.cancel();
        break;
      }

      const { done, value } = read;
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
