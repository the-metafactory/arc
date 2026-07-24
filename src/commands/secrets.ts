/**
 * F-6e (arc#229) — `arc secrets` lifecycle verbs.
 *
 *   arc secrets list   <agent>            — stored secret names (never values)
 *   arc secrets check  <agent>            — declared vs stored; exit 1 if missing
 *   arc secrets set    <agent> <secret>   — prompt / --from-env store
 *   arc secrets rotate <agent> <secret>   — no-overwrite replace (delete+add)
 *   arc secrets remove <agent> [<secret>] — one or all declared secrets
 *
 * The verb implementations below are pure functions over an injected
 * SecretBackend + (where needed) the agent's manifest, so they unit-test
 * without a DB or keychain. The commander wrapper in cli.ts resolves the real
 * backend (`resolveSecretBackend`) and manifest (`readManifest` off the
 * installed package's `install_path`).
 *
 * NEVER-LOG (issue §E): every verb prints NAMES only. No code path emits a
 * value to stdout/stderr.
 */

import type { ArcManifest } from "../types.js";
import { normalizeDeclaredSecrets, type SecretBackend, SecretListUnsupportedError } from "../lib/secrets.js";
import {
  provisionSecrets,
  validateSecretPresence,
  type SecretPrompt,
} from "../lib/secret-provision.js";
import { errorMessage } from "../lib/errors.js";

interface BaseCtx {
  agent: string;
  backend: SecretBackend;
}

/** `arc secrets list <agent>` — stored secret NAMES only. */
export async function secretsList(ctx: BaseCtx): Promise<number> {
  let names: string[];
  try {
    names = await ctx.backend.list();
  } catch (err) {
    if (err instanceof SecretListUnsupportedError) {
      // Honest report instead of a silently-empty list (arc#234 review nit 2):
      // the Keychain backend can't enumerate. Point at the backend-agnostic
      // `check` verb. Exit 2 (distinct from 0 "none" and 1 "error").
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  if (names.length === 0) {
    console.log(`No secrets stored for agent '${ctx.agent}'.`);
    return 0;
  }
  console.log(`Secrets stored for '${ctx.agent}':`);
  for (const name of names.sort()) {
    console.log(`  ${name}`);
  }
  return 0;
}

/**
 * `arc secrets check <agent>` — verify every declared secret is present.
 * Exit 1 (loud, not silent — issue §E) when any declared secret is missing.
 */
export async function secretsCheck(
  manifest: ArcManifest,
  ctx: BaseCtx,
): Promise<number> {
  const report = await validateSecretPresence(manifest, ctx);
  const declared = normalizeDeclaredSecrets(manifest.capabilities?.secrets);
  if (declared.length === 0) {
    console.log(`Agent '${ctx.agent}' declares no secrets.`);
    return 0;
  }

  console.log(`Secret status for '${ctx.agent}':`);
  for (const name of report.present) {
    console.log(`  ✓ ${name}`);
  }
  for (const name of report.missing) {
    console.log(`  ✗ ${name} (missing)`);
  }

  if (!report.ok) {
    console.error(
      `Missing ${report.missing.length} secret(s). ` +
        `Run \`arc secrets set ${ctx.agent} <secret>\` to provision.`,
    );
    return 1;
  }
  return 0;
}

/** Options for {@link secretsSet}. */
export interface SecretsSetOpts extends BaseCtx {
  /** `--from-env`: take the value from `env[secret]` rather than prompting. */
  fromEnv?: boolean;
  /** Env source for `--from-env` (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Interactive prompt (defaults to the no-echo terminal read). */
  prompt?: SecretPrompt;
}

/** `arc secrets set <agent> <secret>` — store via prompt or --from-env. */
export async function secretsSet(
  secret: string,
  opts: SecretsSetOpts,
): Promise<number> {
  // Reuse the install-time flow over a single-secret synthetic manifest so the
  // prompt / from-env / store path stays one implementation.
  const synthetic: ArcManifest = {
    name: opts.agent,
    version: "0",
    type: "agent",
    capabilities: { secrets: [secret] },
  };
  try {
    const result = await provisionSecrets(synthetic, {
      agent: opts.agent,
      backend: opts.backend,
      fromEnv: opts.fromEnv,
      env: opts.env,
      prompt: opts.prompt,
    });
    if (result.stored.length === 0) {
      console.error(
        opts.fromEnv
          ? `Env var ${secret} is not set; nothing stored.`
          : `No value entered for ${secret}; nothing stored.`,
      );
      return 1;
    }
    console.log(`✓ Stored ${secret} for '${opts.agent}'.`);
    return 0;
  } catch (err) {
    // errorMessage is name-scoped; the value is never in the message.
    console.error(`Failed to set ${secret}: ${errorMessage(err)}`);
    return 1;
  }
}

/**
 * `arc secrets rotate <agent> <secret>` — replace the value with NO in-place
 * overwrite (issue §E): the backend deletes the old entry then adds the new.
 * Aborts (exit 1, old value intact) on empty input.
 */
export async function secretsRotate(
  secret: string,
  opts: SecretsSetOpts,
): Promise<number> {
  const env = opts.env ?? process.env;
  let value: string | undefined;

  if (opts.fromEnv) {
    value = env[secret];
    if (value === undefined || value === "") {
      console.error(`Env var ${secret} is not set; rotation aborted (old value intact).`);
      return 1;
    }
  } else {
    const prompt = opts.prompt;
    const entered = prompt ? await prompt(secret) : "";
    if (entered === "") {
      console.error(`No value entered; rotation aborted (old value intact).`);
      return 1;
    }
    value = entered;
  }

  try {
    await opts.backend.rotate(secret, value);
    console.log(`✓ Rotated ${secret} for '${opts.agent}'.`);
    return 0;
  } catch (err) {
    console.error(`Failed to rotate ${secret}: ${errorMessage(err)}`);
    return 1;
  }
}

/** Options for {@link secretsRemove}. */
export interface SecretsRemoveOpts extends BaseCtx {
  /** A single secret name to remove. When absent, all declared are removed. */
  name?: string;
  /** Manifest — required to enumerate declared secrets for the remove-all path. */
  manifest?: ArcManifest;
}

/**
 * `arc secrets remove <agent> [<secret>]` — remove one named secret, or all of
 * the agent's declared secrets when no name is given.
 */
export async function secretsRemove(opts: SecretsRemoveOpts): Promise<number> {
  try {
    if (opts.name) {
      await opts.backend.remove(opts.name);
      console.log(`✓ Removed ${opts.name} for '${opts.agent}'.`);
      return 0;
    }

    const declared = normalizeDeclaredSecrets(opts.manifest?.capabilities?.secrets);
    if (declared.length === 0) {
      console.log(`Agent '${opts.agent}' declares no secrets; nothing to remove.`);
      return 0;
    }
    for (const { name } of declared) {
      await opts.backend.remove(name);
      console.log(`✓ Removed ${name} for '${opts.agent}'.`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed to remove secret(s): ${errorMessage(err)}`);
    return 1;
  }
}
