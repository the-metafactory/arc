/**
 * cortex-config-provision.ts — install-time cortex config composition
 * (F-6a, cortex#858).
 *
 * When `arc install` lands a package whose manifest declares a `cortex_config`
 * fragment AND the install target host is a cortex stack, this module merges the
 * fragment's capabilities/policy into the stack's `stacks/<id>.yaml` by invoking
 * the cortex CLI verb:
 *
 *     cortex config merge --config <stack-config-dir> --fragment <file> [--stack <id>]
 *
 * It is the SINGLE dedicated home for that logic — the same merge-coordination
 * pattern the sibling F-6 slices established:
 *   - IDENTITY (F-6b, arc#228) lives in `identity-provision.ts`;
 *   - SECRETS  (F-6e, arc#229) lives in `secret-provision-install.ts`;
 *   - LIBRARY ORDERING (F-6c, arc#227) lives in `install-transaction.ts`;
 *   - CORTEX CONFIG (F-6a) lives HERE.
 * install.ts wires it in as ONE clearly-commented hook call at the cortex-config
 * step (the design's "step 6c"), so the concurrent install lanes touch
 * non-adjacent insertion points.
 *
 * Division of labour (Anti-Abstraction Gate): arc does NOT reimplement the
 * merge. cortex's `config merge` owns the deep semantics — id-keyed deep merge,
 * idempotency (re-running the same fragment is a no-op), `CortexConfigSchema`
 * validation of the composed whole, a timestamped backup before write, and a
 * post-write re-compose + restore-on-failure. arc only:
 *   1. decides the step applies (manifest declares it + host is cortex),
 *   2. marshals the fragment to a file the verb can read, and
 *   3. invokes the verb and maps its exit code to a fail-closed result.
 *
 * Fail-closed (issue acceptance criterion): a non-zero exit from the verb fails
 * the install. Because the verb is idempotent and writes a 0o600 backup, an arc
 * retry after fixing the cause is safe — a second run with the same fragment is
 * a no-op, and a partial failure left the original restored from backup.
 *
 * Test seam: production calls go through `Bun.spawnSync` via `defaultRunner`;
 * tests swap a runner through `__setRunnerForTests` (gated on `ARC_TEST_MODE=1`
 * / `NODE_ENV=test`, mirroring `nats-broker.ts`) so the unit suite never shells
 * out to a real cortex.
 */

import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, isAbsolute, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { ArcManifest, CortexConfigFragment, HostAdapter } from "../types.js";

// ---------------------------------------------------------------------------
// Spawn seam (mirrors nats-broker.ts) — production spawns; tests inject.
// ---------------------------------------------------------------------------

export interface CortexSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs an argv and returns its exit code + captured streams. */
export type CortexRunner = (argv: string[]) => CortexSpawnResult;

const defaultRunner: CortexRunner = (argv) => {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

let runner: CortexRunner = defaultRunner;

function assertTestMode(seam: string): void {
  if (process.env.ARC_TEST_MODE !== "1" && process.env.NODE_ENV !== "test") {
    throw new Error(`${seam} is a test-only seam. Set ARC_TEST_MODE=1 or NODE_ENV=test.`);
  }
}

/** Test-only: swap the spawn runner so the suite never shells out to cortex. */
export function __setRunnerForTests(r: CortexRunner): void {
  assertTestMode("__setRunnerForTests");
  runner = r;
}

/** Test-only: restore the production spawn runner. */
export function __resetRunnerForTests(): void {
  assertTestMode("__resetRunnerForTests");
  runner = defaultRunner;
}

// ---------------------------------------------------------------------------
// cortex CLI resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the argv prefix that invokes `cortex config merge`.
 *
 * Resolution order (first hit wins):
 *   1. `ARC_CORTEX_BIN` / `MF_CORTEX_BIN` env — an explicit path to the cortex
 *      CLI entry. A `.ts` target is run with `bun`; anything else is exec'd
 *      directly. This is the test/CI/non-PATH escape hatch and the override an
 *      operator sets when cortex isn't on PATH.
 *   2. A `cortex` binary on PATH (`Bun.which`) → `["cortex", "config", "merge"]`.
 *
 * Returns null when neither is available — the caller treats that as a
 * fail-closed "cannot run the merge" rather than silently skipping it.
 */
export function resolveCortexMergeArgv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const explicit = env.ARC_CORTEX_BIN ?? env.MF_CORTEX_BIN;
  if (explicit && explicit.length > 0) {
    return explicit.endsWith(".ts")
      ? ["bun", explicit, "config", "merge"]
      : [explicit, "config", "merge"];
  }

  // Honor an injected PATH (tests pin it) so resolution is deterministic; in
  // production `env` is process.env and Bun.which uses the same PATH it would
  // by default.
  const onPath = env.PATH ? Bun.which("cortex", { PATH: env.PATH }) : Bun.which("cortex");
  if (onPath) return ["cortex", "config", "merge"];

  return null;
}

// ---------------------------------------------------------------------------
// Host detection + config-dir resolution
// ---------------------------------------------------------------------------

/**
 * True when the install target host is a cortex stack.
 *
 * Reuses the host-awareness the F-6b/c/e slices wired (we do NOT invent a new
 * detection mechanism): a cortex install is the `cortex` HostAdapter, and its
 * `detect()` confirms a materialised config on disk (`cortex.yaml` present at
 * `paths.settingsPath` — see `src/lib/hosts/cortex.ts`). Both must hold: the id
 * tells us this is the cortex backend, `detect()` tells us the stack is actually
 * present (not a fresh box without `cortex init` run yet).
 */
export function isTargetHostCortex(host: HostAdapter): boolean {
  return host.id === "cortex" && host.detect();
}

/**
 * The config-split directory the cortex daemon points `--config` at — the
 * cortex host's root (`~/.config/cortex` by default, or a test-overridden
 * configRoot). cortex's `config merge --config` accepts this directory and
 * resolves the target `stacks/<id>.yaml` itself (with `--stack` disambiguating
 * when more than one stack file is present).
 */
export function stackConfigDirForHost(host: HostAdapter): string {
  return host.paths.root;
}

// ---------------------------------------------------------------------------
// Step result + the install.ts hook
// ---------------------------------------------------------------------------

export interface CortexConfigStepResult {
  /** True iff the step ran and the merge succeeded, OR the step did not apply. */
  success: boolean;
  /** Set when `success: false` — a fail-closed, actionable message. */
  error?: string;
  /**
   * Why the step did not perform a merge, when it didn't:
   *   - "no-fragment"   — manifest declares no `cortex_config`.
   *   - "host-not-cortex" — target host is not a (detected) cortex stack.
   * Absent when a merge was actually invoked.
   */
  skippedReason?: "no-fragment" | "host-not-cortex";
  /** True when the verb was actually invoked (a merge attempt happened). */
  merged?: boolean;
}

export interface CortexConfigStepOpts {
  /** Target host adapter (decides host-is-cortex + the config dir). */
  host: HostAdapter;
  /** Absolute path to the installed package dir (resolves a `path` fragment). */
  installPath: string;
  /**
   * Target stack id (`{principal}/{stack}`). Forwarded as `--stack`. Optional:
   * cortex requires it only when the config dir holds more than one stack file.
   */
  stackId?: string;
  /** Suppress stdout progress lines (non-interactive / test use). */
  quiet?: boolean;
  /** Test seam — inject the env consulted for cortex-bin resolution. */
  env?: Record<string, string | undefined>;
}

/**
 * The install.ts CORTEX-CONFIG hook — the SINGLE entry point install calls at
 * the cortex-config step. No-op (success) when the manifest declares no
 * `cortex_config` or the target host is not a cortex stack. Otherwise marshals
 * the fragment and invokes `cortex config merge`, returning a fail-closed
 * result on any error.
 *
 * Never throws — every failure path returns `success: false` with a message so
 * install.ts can fail the install cleanly (and roll back its landed state via
 * the existing transaction path) rather than crash.
 */
export function maybeMergeCortexConfig(
  manifest: ArcManifest,
  opts: CortexConfigStepOpts,
): CortexConfigStepResult {
  const fragment = manifest.cortex_config;
  if (!fragment) {
    return { success: true, skippedReason: "no-fragment" };
  }

  if (!isTargetHostCortex(opts.host)) {
    // Not an error: a package may carry a cortex_config AND be installed onto a
    // non-cortex host (e.g. claude-code). The fragment simply doesn't apply
    // here; the cortex stack picks it up when the package is installed there.
    if (!opts.quiet) {
      process.stdout.write(
        `cortex-config: package declares cortex_config but target host is not a cortex stack — skipping merge\n`,
      );
    }
    return { success: true, skippedReason: "host-not-cortex" };
  }

  const configDir = stackConfigDirForHost(opts.host);

  // Marshal the fragment to a file the verb can read. An inline fragment is
  // written to a temp file we clean up; a `path` pointer resolves to a file
  // inside the package (validated relative at manifest-read time).
  let fragmentFile: string;
  let tmpDir: string | undefined;
  try {
    const marshalled = marshalFragment(fragment, opts.installPath);
    fragmentFile = marshalled.fragmentFile;
    tmpDir = marshalled.tmpDir;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `cortex-config: cannot prepare fragment for merge: ${msg}`,
    };
  }

  try {
    const argvPrefix = resolveCortexMergeArgv(opts.env);
    if (!argvPrefix) {
      // Fail-closed: the package needs its cortex config merged but we can't
      // find the cortex CLI. Don't silently skip — the install must fail so the
      // operator wires `cortex` onto PATH (or sets ARC_CORTEX_BIN) and retries.
      return {
        success: false,
        error:
          `cortex-config: cortex_config declared but the cortex CLI was not found. ` +
          `Put 'cortex' on PATH or set ARC_CORTEX_BIN to the cortex CLI, then re-run the install (the merge is idempotent).`,
      };
    }

    const argv = [...argvPrefix, "--config", configDir, "--fragment", fragmentFile];
    if (opts.stackId) argv.push("--stack", opts.stackId);

    if (!opts.quiet) {
      // Log the invocation WITHOUT the fragment file's contents (paths only).
      process.stdout.write(`cortex-config: merging fragment into ${configDir}\n`);
    }

    const result = runner(argv);
    if (result.exitCode !== 0) {
      // Surface cortex's own diagnostic (it writes a per-entry merge report +
      // the failing schema error to stderr). Fail-closed.
      const detail = (result.stderr || result.stdout || "").trim();
      return {
        success: false,
        error:
          `cortex-config: \`cortex config merge\` failed (exit ${result.exitCode})` +
          (detail ? `:\n${detail}` : `. Re-run after fixing the cause — the merge is idempotent.`),
      };
    }

    if (!opts.quiet && result.stderr.trim()) {
      // cortex reports the merge disposition (added/skipped/changed) on stderr.
      process.stdout.write(`${result.stderr.trim()}\n`);
    }

    return { success: true, merged: true };
  } finally {
    // Clean up only the temp file we created for an inline fragment; a `path`
    // pointer lives inside the package and is not ours to remove.
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Resolve the fragment to an on-disk YAML file for `--fragment`.
 *
 * - Path pointer (`{ path }`): resolve relative to the package install dir,
 *   guard against escaping it (defense-in-depth — the path was already
 *   validated relative/no-`..` at manifest-read time), and require it to exist.
 * - Inline (`{ capabilities?, policy? }`): serialize to a temp file. The caller
 *   removes `tmpDir` in a finally.
 */
export function marshalFragment(
  fragment: CortexConfigFragment,
  installPath: string,
): { fragmentFile: string; tmpDir?: string } {
  if (typeof fragment.path === "string" && fragment.path.length > 0) {
    const abs = resolve(installPath, fragment.path);
    // Containment guard: the resolved path must stay inside the package.
    const rel = relative(installPath, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `cortex_config.path '${fragment.path}' escapes the package directory`,
      );
    }
    if (!existsSync(abs)) {
      throw new Error(
        `cortex_config.path '${fragment.path}' does not exist in the package (resolved: ${abs})`,
      );
    }
    return { fragmentFile: abs };
  }

  // Inline form — write only the capability/policy subset (the manifest
  // validator already rejected any other key).
  const body: Record<string, unknown> = {};
  if (fragment.capabilities !== undefined) body.capabilities = fragment.capabilities;
  if (fragment.policy !== undefined) body.policy = fragment.policy;

  // Defensive guard (self-review §1): the install path always runs through the
  // manifest validator, which rejects an empty fragment — but this fn is also
  // exported and callable directly. An empty inline body would otherwise write
  // `{}`, which cortex rejects with an opaque exit 1. Fail with an arc-side
  // message instead.
  if (Object.keys(body).length === 0) {
    throw new Error(
      "cortex_config inline fragment is empty — declare 'capabilities' and/or 'policy', or use a 'path' pointer",
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "arc-cortex-fragment-"));
  const fragmentFile = join(tmpDir, "fragment.yaml");
  writeFileSync(fragmentFile, YAML.stringify(body, { indent: 2, lineWidth: 0 }), "utf-8");
  return { fragmentFile, tmpDir };
}
