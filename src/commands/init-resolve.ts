import { basename, join } from "path";
import { platform } from "os";

/**
 * Resolve `arc init`'s `[name]` arg + cwd into a `{name, targetDir}` tuple
 * — pure function so it can be unit-tested without spawning the CLI.
 *
 * arc#107 semantics:
 *   - argless OR `.` OR `<name>` matching basename(cwd) → scaffold in cwd
 *   - `<name>` different from basename(cwd) → ./<name>/ (no `arc-<type>-` prefix)
 *   - explicit `dirOverride` (CLI `--dir`) always wins for targetDir
 *
 * Discriminated union return: `{ok: true, ...}` on success,
 * `{ok: false, reason, detail}` on validation failure. Discriminate
 * via `r.ok` (explicit boolean per sage P148 cycle 3 — implicit
 * field-absence discriminators are fragile to type drift).
 */
export type ResolvedInitTarget =
  | { ok: true; name: string; targetDir: string }
  | { ok: false; reason: "invalid-name" | "invalid-dir"; detail: string };

export function resolveInitTarget(opts: {
  argName?: string;
  cwd: string;
  dirOverride?: string;
  /**
   * Override the platform for basename case-folding (test isolation).
   * Production callers omit this and `os.platform()` decides. Sage P148
   * cycle 5 — macOS / Windows are case-insensitive by default, so
   * `arc init Foo` in `/x/foo` should match in-place.
   */
  platformOverride?: NodeJS.Platform;
}): ResolvedInitTarget {
  const cwdBasename = basename(opts.cwd);
  const arg = opts.argName?.trim();
  // Case-insensitive match on darwin / win32 (their default filesystems
  // are case-insensitive); strict on linux + others. The actual `name`
  // returned uses the cwd basename's casing when matched, so the
  // manifest reflects what the filesystem actually shows.
  const plat = opts.platformOverride ?? platform();
  const caseInsensitive = plat === "darwin" || plat === "win32";
  const nameMatches =
    arg !== undefined &&
    arg !== "" &&
    arg !== "." &&
    (caseInsensitive
      ? arg.toLowerCase() === cwdBasename.toLowerCase()
      : arg === cwdBasename);
  // `inCwd` decides whether we scaffold in cwd (argless / `.` / matching
  // name) or in a new subdir. Compute once.
  const inCwd = !arg || arg === "." || nameMatches;

  const name = inCwd ? cwdBasename : arg;

  if (!name || /[/\\]|\.\./.test(name)) {
    return {
      ok: false,
      reason: "invalid-name",
      detail: `"${name}" is not a valid package name (no path separators, no "..", non-empty).`,
    };
  }

  // Sage P148 security: validate `--dir` parity with name. Prevent
  // path-traversal-into-shadow scenarios where a wrapper passes
  // untrusted input through `--dir`.
  if (opts.dirOverride !== undefined) {
    if (opts.dirOverride === "" || /\.\.(\/|\\|$)/.test(opts.dirOverride)) {
      return {
        ok: false,
        reason: "invalid-dir",
        detail: `"${opts.dirOverride}" is not a valid --dir target (no "..", non-empty).`,
      };
    }
  }

  const targetDir =
    opts.dirOverride ?? (inCwd ? opts.cwd : join(opts.cwd, name));

  return { ok: true, name, targetDir };
}
