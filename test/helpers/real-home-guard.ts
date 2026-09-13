/**
 * Suite-level guard: a test run must not touch the operator's REAL home.
 *
 * arc#421 round 2, M1. `CLAUDE.md` has always said "tests must NEVER touch real
 * `~/.claude/` or `~/.config/`" — but nothing enforced it, and a plain
 * `bun test` on this repo was writing into the operator's actual home:
 * 25 `~/.config/metafactory/agents/*.provision.json` sidecars (several of them
 * OVERWRITING the operator's own agents), new entries in
 * `~/.config/metafactory/principals.json`, a `~/.config/metafactory/keys/`
 * tree, `~/.config/cortex/agents/`, and `~/.config/nats/*.creds`.
 *
 * The root cause was always the same shape: a module computed a home-rooted
 * path from `os.homedir()` — often into a MODULE-LOAD constant — and the test's
 * `process.env.HOME = tmp` (or `METAFACTORY_CONFIG_DIR = tmp`) came too late,
 * or could never have worked at all. `os.homedir()` honours `$HOME` set at
 * process SPAWN; it ignores an in-process mutation afterwards, and a
 * module-load constant is baked before any `beforeAll` runs.
 *
 * This module does two things, loaded as a `bun test` preload (bunfig.toml):
 *
 *  1. PREVENTS the common case — pins `process.env.HOME` and the `XDG_*` /
 *     roots to a per-run temp directory, so every path
 *     resolved through `userHome()` (src/lib/user-home.ts) or `$XDG_*` lands in
 *     the sandbox even when a test forgot to sandbox it.
 *  2. DETECTS what prevention cannot reach — a raw `os.homedir()` still returns
 *     the real home. So it snapshots the config roots arc writes to and, at
 *     process exit, fails the run loudly and names every path that appeared,
 *     vanished, or changed.
 *
 * It NEVER deletes or repairs anything in the real home: what is residue and
 * what is the operator's own data is the operator's call, not this file's.
 */
import { afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The REAL home — captured from `os.homedir()`, which reads the spawn-time
 * `$HOME` and is therefore unaffected by the pinning below.
 */
const REAL_HOME = homedir();

/**
 * Roots arc reads or writes that belong to the operator, not to a test.
 *
 * `~/.claude` is deliberately absent: the operator's editor session mutates it
 * continuously while tests run, so including it would make the guard a coin
 * flip. Test isolation for `~/.claude` is enforced structurally instead —
 * `createTestEnv()` roots the HostAdapter in its temp dir.
 */
const WATCHED = [
  join(REAL_HOME, ".config", "metafactory"),
  join(REAL_HOME, ".config", "cortex"),
  join(REAL_HOME, ".config", "nats"),
  join(REAL_HOME, ".config", "nsc"),
  join(REAL_HOME, ".local", "share", "metafactory"),
  join(REAL_HOME, ".local", "share", "nats"),
  join(REAL_HOME, ".nsc"),
  join(REAL_HOME, ".sigstore"),
];

/**
 * Subtrees inside a watched root that a LIVE DAEMON owns, not arc's tests.
 *
 * `metafactory/blueprint` holds the blueprint API server's pid file and its
 * serve log, both rewritten continuously while that server runs — so on a
 * developer box with it up, a test run that touched nothing would still trip
 * the guard. Excluding them keeps the signal honest; nothing arc's tests write
 * lands here.
 */
const EXCLUDED = [join(REAL_HOME, ".config", "metafactory", "blueprint")];

/** Walk cap — a pathological tree must not turn the guard into the slow part. */
const MAX_ENTRIES = 20_000;

/** `path -> "<size>:<mtimeMs>"` for every file under every watched root. */
function snapshot(): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string): void => {
    if (seen.size > MAX_ENTRIES) return;
    if (EXCLUDED.some((ex) => dir === ex || dir.startsWith(`${ex}/`))) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or gone — nothing to compare
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(full);
        continue;
      }
      try {
        const st = statSync(full, { throwIfNoEntry: false });
        seen.set(full, st ? `${st.size}:${st.mtimeMs}` : "dangling");
      } catch {
        seen.set(full, "unstattable");
      }
    }
  };
  for (const root of WATCHED) if (existsSync(root)) walk(root);
  return seen;
}

const BEFORE = snapshot();

// ── Prevention ───────────────────────────────────────────────────────────────
// A per-run sandbox home. Set BEFORE any test module is imported, so a module
// that still computes a home-rooted constant at load time computes it against
// the sandbox (as long as it resolves through `userHome()` / `$XDG_*`).
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "arc-test-home-"));
mkdirSync(join(SANDBOX_HOME, ".config"), { recursive: true });
process.env.HOME = SANDBOX_HOME;
process.env.XDG_CONFIG_HOME = join(SANDBOX_HOME, ".config");
process.env.XDG_DATA_HOME = join(SANDBOX_HOME, ".local", "share");
process.env.XDG_STATE_HOME = join(SANDBOX_HOME, ".local", "state");
process.env.XDG_CACHE_HOME = join(SANDBOX_HOME, ".cache");
// Deliberately NOT CORTEX_CONFIG_DIR: that variable is a VERBATIM override
// that outranks an explicitly injected `seam.home`, so pinning it here would
// silently defeat every test that passes its own cortex root
// (`resolveCortexConfigRoot({ home })`). `cortex-config-dir.ts` resolves its
// default through `userHome()` instead, so the `$HOME` pin above already
// covers the un-injected case without overriding the injected one.

// ── Detection ────────────────────────────────────────────────────────────────
// Registered BOTH ways on purpose. `afterAll` in a preload is bun:test's
// documented global-teardown hook and is what actually fires under
// `bun test` — a bare `process.on("exit")` does NOT (observed: an injected
// real-home write went undetected until this hook was added). The `exit`
// listener stays as the backstop for a runner that bypasses the hook.
const check = (): void => {
  const after = snapshot();
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, stamp] of after) {
    const before = BEFORE.get(path);
    if (before === undefined) added.push(path);
    else if (before !== stamp) changed.push(path);
  }
  for (const path of BEFORE.keys()) if (!after.has(path)) removed.push(path);

  const total = added.length + changed.length + removed.length;
  if (total === 0) return;

  const list = (label: string, paths: string[]): string =>
    paths.length ? `\n  ${label} (${paths.length}):\n${paths.slice(0, 40).map((p) => `    ${p}`).join("\n")}${paths.length > 40 ? `\n    … and ${paths.length - 40} more` : ""}` : "";

  process.stderr.write(
    `\n[31m✗ REAL-HOME LEAK — this test run modified the operator's home directory.[0m\n` +
      `  Home: ${REAL_HOME}\n` +
      `  A test resolved a path through a raw os.homedir() instead of an injected\n` +
      `  root or src/lib/user-home.ts's userHome(). Find it, pass the root\n` +
      `  explicitly, and re-run. Nothing has been deleted — decide for yourself\n` +
      `  what is test residue and what is yours.` +
      list("added", added) +
      list("changed", changed) +
      list("removed", removed) +
      `\n`,
  );
  process.exitCode = 1;
};

let checked = false;
const checkOnce = (): void => {
  if (checked) return;
  checked = true;
  check();
};

afterAll(checkOnce);
process.on("exit", checkOnce);
