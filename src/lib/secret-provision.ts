/**
 * F-6e (arc#229) — install-time secret provisioning flow.
 *
 * Wires the storage backends (`secrets.ts`) into the install lifecycle:
 *
 *   - {@link provisionSecrets}    — for each `capabilities.secrets` entry, resolve
 *     a value via interactive prompt / `--from-env` / `--skip-secrets`, and store
 *     it through the backend.
 *   - {@link validateSecretPresence} — which declared secrets are stored vs missing
 *     (backs `arc secrets check`).
 *   - {@link injectSecretsIntoEnv}  — retrieve stored secrets and merge them into a
 *     child-process env (plist render env / postinstall env). Per design §6.2
 *     step 5 + §3.5b: secrets reach *per-agent env*, never the brief.
 *
 * NEVER-LOG (issue §E): the value flows prompt → backend.store and
 * backend.retrieve → env only. No function here logs a value, and the result
 * structs carry NAMES only — `provisionSecrets` never returns a value.
 */

import type { ArcManifest } from "../types.js";
import { normalizeDeclaredSecrets, type SecretBackend, type DeclaredSecret } from "./secrets.js";
import { errorMessage } from "./errors.js";

/**
 * Prompt the principal for a single secret value. Returns the entered string
 * (empty string ⇒ the principal chose to skip this secret). The default
 * implementation is a no-echo terminal read; tests inject their own.
 */
export type SecretPrompt = (name: string) => Promise<string>;

/** Shared per-agent context for the provisioning functions. */
interface SecretContext {
  /** Agent name (storage scope). */
  agent: string;
  /** Resolved storage backend for this agent. */
  backend: SecretBackend;
}

/** Options controlling {@link provisionSecrets}. */
export interface ProvisionOpts extends SecretContext {
  /** `--skip-secrets`: store nothing; report all declared as skipped. */
  skipSecrets?: boolean;
  /** `--from-env`: read each declared secret from `env` (no prompt). */
  fromEnv?: boolean;
  /** Env source for `fromEnv` (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Interactive prompt (defaults to a no-echo terminal read). */
  prompt?: SecretPrompt;
  /** Suppress progress logging (NAMES only — never values). */
  quiet?: boolean;
}

/** Outcome of a provisioning pass — NAMES only, never values. */
export interface ProvisionResult {
  /** Secrets stored this pass. */
  stored: string[];
  /** Declared secrets left unstored (skipped / absent-from-env / empty input). */
  skipped: string[];
}

/**
 * Declared secrets for a manifest, folded to `{name, optional}` (empty when
 * none). Both author shapes (bare NAME / object form) collapse here so every
 * consumer below iterates NAMES, never raw objects (arc#363).
 */
function declaredSecrets(manifest: ArcManifest): DeclaredSecret[] {
  return normalizeDeclaredSecrets(manifest.capabilities?.secrets);
}

/**
 * Resolve + store each declared secret per the active mode. Returns NAMES
 * only. Idempotent in the sense that re-running re-prompts / re-reads; storage
 * overwrites in place (rotate is the explicit no-overwrite path).
 */
export async function provisionSecrets(
  manifest: ArcManifest,
  opts: ProvisionOpts,
): Promise<ProvisionResult> {
  const declared = declaredSecrets(manifest);
  const stored: string[] = [];
  const skipped: string[] = [];

  if (declared.length === 0) {
    return { stored, skipped };
  }

  if (opts.skipSecrets) {
    // Daemon starts; first use fails with a clear message (issue §A.4). Record
    // the skip so the caller can surface a hint.
    return { stored: [], skipped: declared.map((d) => d.name) };
  }

  const env = opts.env ?? process.env;

  for (const { name } of declared) {
    let value: string | undefined;

    if (opts.fromEnv) {
      value = env[name];
      if (value === undefined || value === "") {
        skipped.push(name);
        continue;
      }
    } else {
      const prompt = opts.prompt ?? defaultSecretPrompt;
      const entered = await prompt(name);
      if (entered === "") {
        // Return-to-skip.
        skipped.push(name);
        continue;
      }
      value = entered;
    }

    try {
      await opts.backend.store(name, value);
    } catch (err) {
      // NEVER include the value in the error (issue §E). errorMessage()
      // surfaces only the backend's own message, which is name-scoped. Chain
      // the cause so the underlying backend error survives for debuggability
      // (the cause's message is also name-scoped — never carries the value).
      throw new Error(`failed to store secret ${name}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    stored.push(name);
    if (!opts.quiet) {
      // NAME only.
      console.log(`  ✓ Secret stored: ${name}`);
    }
  }

  return { stored, skipped };
}

/** Report for {@link validateSecretPresence} — NAMES only. */
export interface PresenceReport {
  present: string[];
  missing: string[];
  /** True iff every declared secret is stored (or none declared). */
  ok: boolean;
}

/**
 * Check which declared secrets are stored. Backs `arc secrets check <agent>`
 * and the daemon-start "loud failure on missing" path (issue §E).
 */
export async function validateSecretPresence(
  manifest: ArcManifest,
  ctx: SecretContext,
): Promise<PresenceReport> {
  const declared = declaredSecrets(manifest);
  const present: string[] = [];
  const missing: string[] = [];

  for (const { name } of declared) {
    const value = await ctx.backend.retrieve(name);
    if (value === null || value === "") {
      missing.push(name);
    } else {
      present.push(name);
    }
  }

  return { present, missing, ok: missing.length === 0 };
}

/** Options for {@link injectSecretsIntoEnv}. */
export interface InjectOpts extends SecretContext {
  /** Base env to merge into (e.g. `process.env` filtered, or {}). */
  baseEnv: Record<string, string>;
}

/**
 * Retrieve every declared+stored secret and merge it into a child-process env.
 * A declared-but-unstored secret is OMITTED (never injected as `undefined`) so
 * the daemon fails at first use with a clear message rather than seeing an
 * empty value.
 *
 * The returned object is a fresh copy of `baseEnv` plus the secrets — callers
 * pass it straight to `runLifecycleScripts({ env })` / the plist render env,
 * and the SECRET keys are scoped to that single child invocation (issue §E
 * "unset after postinstall": the parent never mutates its own env).
 */
export async function injectSecretsIntoEnv(
  manifest: ArcManifest,
  opts: InjectOpts,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...opts.baseEnv };
  const declared = declaredSecrets(manifest);

  for (const { name } of declared) {
    const value = await opts.backend.retrieve(name);
    if (value !== null && value !== "") {
      env[name] = value;
    }
  }

  return env;
}

/**
 * Default no-echo terminal prompt for a secret value.
 *
 * Disables echo via raw mode for the duration of the read so the typed value
 * never appears on screen (issue §A.2 "[secure input, no echo]"). On a
 * non-TTY stdin returns "" (skip) — a non-interactive install must use
 * `--from-env` or `--skip-secrets`, never block on a prompt.
 */
export function defaultSecretPrompt(name: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.resolve("");
  }

  process.stdout.write(`Enter ${name} (or press Return to skip): `);

  return new Promise<string>((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === "") {
          // Ctrl-C — abort the whole process; never echo partial input.
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          // Backspace — drop one char from the buffer (no echo to manage).
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.resume();
    stdin.setEncoding("utf-8");
    if (stdin.isTTY) stdin.setRawMode(true); // suppress echo
    stdin.on("data", onData);
  });
}
