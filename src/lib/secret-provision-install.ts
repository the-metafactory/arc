/**
 * F-6e (arc#229) — install-time secret bridge.
 *
 * Thin glue between `commands/install.ts` and the storage + flow modules
 * (`secrets.ts`, `secret-provision.ts`). Keeps install.ts to two clearly
 * commented hook calls (provision + env-build) at the SECRETS step.
 *
 * Backend selection: Keychain on macOS when the `security` CLI is available,
 * else the chmod-600 FileBackend under `arc.secretsDir/<agent>/`. The agent
 * scope is the manifest name (an installed `type: agent` package's name is its
 * agent id; dev-loop's agents install as named library artifacts).
 *
 * NEVER-LOG (issue §E): nothing here logs a value. Skip warnings list NAMES.
 */

import { homedir, userInfo } from "os";
import type { ArcManifest, ArcPaths } from "../types.js";
import {
  resolveSecretBackend,
  type SecretBackend,
} from "./secrets.js";
import {
  provisionSecrets,
  injectSecretsIntoEnv,
} from "./secret-provision.js";

/** Resolve the storage backend for a manifest's agent scope. */
export function backendForManifest(
  manifest: ArcManifest,
  arc: ArcPaths,
  overrides?: {
    platform?: string;
    username?: string;
    backend?: SecretBackend;
  },
): SecretBackend {
  if (overrides?.backend) return overrides.backend;
  return resolveSecretBackend(manifest.name, {
    platform: overrides?.platform ?? process.platform,
    secretsRoot: arc.secretsDir,
    username: overrides?.username ?? safeUsername(),
  });
}

/** Best-effort current username for Keychain account scoping. */
function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    // userInfo throws on some sandboxes with no passwd entry — fall back to a
    // stable, non-secret value (the home dir basename). Never throws.
    return homedir().split("/").filter(Boolean).pop() ?? "user";
  }
}

/** Outcome of the install-time SECRETS step. */
export interface SecretStepResult {
  success: boolean;
  error?: string;
  /** Stored secret NAMES (never values). */
  stored: string[];
  /** Declared-but-unstored NAMES (skip / from-env-absent / empty input). */
  skipped: string[];
}

/** Options for {@link installTimeProvisionSecrets}. */
export interface InstallSecretStepOpts {
  arc: ArcPaths;
  skipSecrets?: boolean;
  fromEnv?: boolean;
  quiet?: boolean;
  /** Test seams — injected platform / username / backend / env / prompt. */
  platform?: string;
  username?: string;
  backend?: SecretBackend;
  env?: Record<string, string | undefined>;
  prompt?: (name: string) => Promise<string>;
}

/**
 * The install.ts SECRETS hook: provision the manifest's declared secrets and
 * surface a skip warning. Fail-closed-loud: a storage failure returns
 * `success: false` so the install aborts cleanly; a skip just WARNs (the
 * daemon will fail at first use with a clear message — issue §A.4).
 */
export async function installTimeProvisionSecrets(
  manifest: ArcManifest,
  opts: InstallSecretStepOpts,
): Promise<SecretStepResult> {
  const declared = manifest.capabilities?.secrets ?? [];
  if (declared.length === 0) {
    return { success: true, stored: [], skipped: [] };
  }

  const backend = backendForManifest(manifest, opts.arc, {
    platform: opts.platform,
    username: opts.username,
    backend: opts.backend,
  });

  try {
    const result = await provisionSecrets(manifest, {
      agent: manifest.name,
      backend,
      skipSecrets: opts.skipSecrets,
      fromEnv: opts.fromEnv,
      env: opts.env,
      prompt: opts.prompt,
      quiet: opts.quiet,
    });

    if (!opts.quiet && result.skipped.length > 0) {
      // NAMES only. Loud, not silent — the operator must know the daemon will
      // fail at first use until these are provisioned.
      console.warn(
        `  ⚠ Secrets not provisioned for '${manifest.name}': ${result.skipped.join(", ")}. ` +
          `The agent will fail at first use until you run ` +
          `\`arc secrets set ${manifest.name} <secret>\`.`,
      );
    }

    return { success: true, stored: result.stored, skipped: result.skipped };
  } catch (err) {
    // errorMessage is name-scoped (the storage layer never embeds a value).
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Secret provisioning failed: ${message}`,
      stored: [],
      skipped: declared,
    };
  }
}

/**
 * Build the postinstall env for a manifest: arc's process env plus the agent's
 * stored secrets. A fresh object scoped to the child invocation; arc's own
 * process env is never mutated, so the secrets are gone when postinstall exits
 * (issue §E "unset after postinstall").
 */
export async function buildSecretEnvForInstall(
  manifest: ArcManifest,
  opts: {
    arc: ArcPaths;
    platform?: string;
    username?: string;
    backend?: SecretBackend;
    baseEnv?: Record<string, string>;
  },
): Promise<Record<string, string>> {
  const declared = manifest.capabilities?.secrets ?? [];
  // The runScript runner already spreads `process.env` first, then `opts.env`.
  // We pass ONLY the secrets here so we never re-materialize the whole
  // environment into a logged object — runScript merges it in.
  const baseEnv = opts.baseEnv ?? {};
  if (declared.length === 0) return baseEnv;

  const backend = backendForManifest(manifest, opts.arc, {
    platform: opts.platform,
    username: opts.username,
    backend: opts.backend,
  });

  return injectSecretsIntoEnv(manifest, {
    agent: manifest.name,
    backend,
    baseEnv,
  });
}
