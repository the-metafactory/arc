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
 * The root cause was always the same shape: something resolved a home-rooted
 * path against the SPAWN-time environment while the test had only changed the
 * IN-PROCESS one. Two carriers, both of them real:
 *
 *  - `os.homedir()` — honours `$HOME` set at process spawn, ignores a later
 *    `process.env.HOME = tmp`. A module-load constant compounds it: baked
 *    before any `beforeAll` runs.
 *  - `Bun.spawnSync(argv)` with no `env` — the child inherits the spawn-time
 *    environ, NOT the mutated `process.env`. Found in round 3: that is how
 *    real `cosign` and real `nsc` wrote `~/.sigstore` and
 *    `~/.config/nats/nsc/nsc.json` straight past the pin below.
 *
 * This module does two things, loaded as a `bun test` preload (bunfig.toml):
 *
 *  1. PREVENTS the common case — pins `process.env.HOME` and the `XDG_*` roots
 *     to a per-run temp directory, so every path resolved through `userHome()`
 *     (src/lib/user-home.ts), `$XDG_*`, or a child process that is passed the
 *     current env lands in the sandbox even when a test forgot to sandbox it.
 *  2. DETECTS what prevention cannot reach. It snapshots the roots arc writes
 *     to and, at process exit, fails the run loudly and names every path that
 *     appeared, vanished, or changed — or, if a root exceeded its walk budget,
 *     says so rather than reporting a clean run it did not actually verify.
 *
 * The snapshot/diff engine lives in `real-home-watch.ts` and is unit-tested in
 * `test/unit/real-home-watch.test.ts`; this file is only the wiring that aims
 * it at the operator's real home.
 *
 * It NEVER deletes or repairs anything in the real home: what is residue and
 * what is the operator's own data is the operator's call, not this file's.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffSnapshots,
  formatLeakReport,
  snapshotRoots,
  type WatchedRoot,
} from "./real-home-watch.js";

/**
 * The REAL home — captured from `os.homedir()`, which reads the spawn-time
 * `$HOME` and is therefore unaffected by the pinning below.
 */
const REAL_HOME = homedir();
const h = (...parts: string[]): string => join(REAL_HOME, ...parts);

/**
 * Roots arc reads or writes that belong to the operator, not to a test.
 *
 * Every entry here is a destination arc's own code can reach. Adding one is
 * cheap; leaving one out is how the incident happened.
 */
/**
 * The `-wal` / `-shm` sidecars sqlite writes beside a database, and NOT the
 * database itself. A live daemon rewrites these continuously; excluding the
 * pair keeps the guard honest about the file that carries the data.
 */
const SQLITE_JOURNAL_SIDECARS = (db: string): string[] => [`${db}-wal`, `${db}-shm`];

export const WATCHED: WatchedRoot[] = [
  {
    path: h(".config", "metafactory"),
    why: "agent provision sidecars, principals.json, keys/ — the incident's blast radius",
    // The blueprint API server rewrites its pid file and serve log continuously
    // while it runs, so on a box with it up a run that touched nothing would
    // still trip the guard. Nothing arc's tests write lands here.
    exclude: [h(".config", "metafactory", "blueprint")],
  },
  {
    path: h(".config", "cortex"),
    why: "cortex agents/ — written by the identity provisioner",
    // Same shape as the blueprint exclusion below: a LIVE cortex stack writes
    // its own runtime state while the suite runs, so a run that touched
    // nothing would still trip the guard. Measured over a 60s idle window on
    // this box: `network-cache/*.json` and a running agent's sqlite WAL.
    // arc's destinations here are `agents/<name>/agent.yaml`, `agents.d/` and
    // the `cortex.*.yaml` fragments — all still watched.
    exclude: [h(".config", "cortex", "logs"), h(".config", "cortex", "network-cache")],
    // A running agent's sqlite JOURNALS sit INSIDE `agents/<name>/`, beside the
    // `agent.yaml` arc writes, so a subtree exclusion would be far too coarse.
    // Only the `-wal` / `-shm` sidecars are skipped: arc's own
    // `identity-provision.ts` CREATES `state.sqlite` itself, so the database
    // file stays watched and a write to it is still a named failure.
    excludeNames: SQLITE_JOURNAL_SIDECARS("state.sqlite"),
  },
  { path: h(".config", "nats"), why: "nsc store + *.creds — written by the real nsc binary" },
  { path: h(".config", "nsc"), why: "alternate nsc store location" },
  {
    path: h(".local", "share", "metafactory"),
    why: "XDG data root for installed packages",
    // A live cortex mission-control daemon checkpoints its sqlite journal here
    // throughout a 2-minute suite run. arc has no writer for that database —
    // the `.db` itself stays watched, only the journals are skipped.
    excludeNames: SQLITE_JOURNAL_SIDECARS("mission-control.db"),
  },
  { path: h(".local", "share", "nats"), why: "XDG data root for nsc keystores" },
  { path: h(".local", "state", "metafactory"), why: "XDG state root — a systemd unit's {{LOG_DIR}}" },
  { path: h(".nsc"), why: "legacy nsc store location" },
  { path: h(".sigstore"), why: "cosign's TUF cache — written by the real cosign binary" },

  // ── arc#421 round 3: the two roots the incident actually hit ──────────────
  {
    path: h(".claude"),
    why: "every skill, agent, command, hook and rules drop arc installs",
    // NARROW exclusions, not a root exclusion. These subtrees are session and
    // telemetry state that the operator's live editor rewrites while the suite
    // runs; including them would make the guard a coin flip. None of them is a
    // destination arc's installer can target — arc drops into `agents/`,
    // `commands/`, `skills/`, `hooks/`, `rules/`, `settings.json` and
    // `CLAUDE.md`, all of which stay watched.
    exclude: [
      h(".claude", "projects"),
      h(".claude", "todos"),
      h(".claude", "history.jsonl"),
      h(".claude", "shell-snapshots"),
      h(".claude", "statsig"),
      h(".claude", "file-history"),
      h(".claude", "paste-cache"),
      h(".claude", "cache"),
      h(".claude", "logs"),
      h(".claude", "debug"),
      h(".claude", "ide"),
      h(".claude", "events"),
      h(".claude", "jobs"),
      h(".claude", "backups"),
      h(".claude", "downloads"),
      h(".claude", "daemon"),
    ],
  },
  {
    path: h("Developer"),
    why: "generateRules writes CLAUDE.md / AGENTS.md into every repo it scans",
    // ── What depth 2 covers, and what it does not (arc#421 round 4, MAJOR B) ─
    //
    // Round 3's comment here claimed the bound was "exactly arc's reach". It
    // is not, and saying so was the defect: `findConsumerRepos` has TWO
    // origins and only one of them is bounded.
    //
    //  - `scan` (upgrade.ts, the `BLUEPRINT_DEV_ROOT` branch) enumerates ONE
    //    level below the dev root and writes at that repo's root. Depth 2
    //    covers it for a dev root at `~/Developer` or one level in
    //    (`~/Developer/<group>/<repo>/CLAUDE.md`), which is how this machine's
    //    worktrees are laid out. That origin IS fully contained.
    //  - `cwd` (upgrade.ts, the always-a-candidate branch) has NO depth bound
    //    at all. Run arc by hand from `~/Developer/a/b/repo` and
    //    `generateRules` writes there, deeper than this walk reaches.
    //
    // The residual is stated rather than hidden, and it is bounded in turn by
    // what a TEST RUN can do: the suite's own `process.cwd()` is this
    // repository's checkout, which `real-home-watch.test.ts` asserts falls
    // inside the walk, and the preload pins `BLUEPRINT_DEV_ROOT` into the
    // sandbox so no scan origin can point at a real tree. Raising the cap to
    // cover an arbitrary operator cwd costs 248,634 files and 10s per
    // snapshot for a case the suite cannot reach.
    maxDirDepth: 2,
    // Declared, with a reason true of THIS root: `generateRules` writes at a
    // repo's ROOT. It has no code path that lands inside a node_modules, so
    // skipping them here is not the arc#421 MAJOR A defect — and the skip is
    // still recorded as a marker, so one that APPEARS is reported.
    prune: {
      names: ["node_modules", ".git"],
      why: "generateRules writes CLAUDE.md / AGENTS.md at a repo ROOT; it has no path into node_modules or .git, and .git churns from every other checkout on the box",
    },
  },

  // ── arc#421 round 4, MAJOR B: destinations that resolve through a raw
  // `homedir()` with no seam, and so were unwatched while the test claimed
  // every reachable destination was. ────────────────────────────────────────
  {
    path: h(".local", "bin"),
    why: "package binaries — `binDir()` (xdg-paths.ts) symlinks shims here",
  },
  {
    path: h("Library", "LaunchAgents"),
    why: "darwin-launchd drops a package's .plist here",
  },
  {
    path: h(".config", "systemd", "user"),
    why: "linux-systemd drops a package's unit here",
  },
  {
    path: h(".bun"),
    why: "`bun install`'s module cache — where arc's un-env'd spawn wrote 290 entries",
    // `install/cache/@t@` is BUN'S OWN transpiler cache, written by the test
    // runner executing this very file — 248 entries per CI run. It is the
    // same shape as the blueprint and cortex exclusions: churn a live process
    // owns. The package cache proper (`install/cache/<pkg>@<version>/…`),
    // which is where arc's un-env'd `bun install` actually landed, stays
    // watched.
    exclude: [h(".bun", "install", "cache", "@t@")],
  },
];

/**
 * A destination arc NAMES but never creates, recorded here so its absence from
 * `WATCHED` is a decision rather than an oversight:
 *
 * `~/Library/Logs/<package>` — `buildLaunchdTokens` substitutes it into a
 * plist as `{{LOG_DIR}}`. arc has no `mkdir` for it; launchd creates it when
 * the operator starts the service. Watching it would mean watching a directory
 * every third-party app on a Mac writes to continuously, turning the guard
 * into a coin flip for a path arc's own code cannot reach.
 */
export const NAMED_BUT_NEVER_WRITTEN = [h("Library", "Logs")] as const;

const BEFORE = snapshotRoots(WATCHED);

// ── Prevention ───────────────────────────────────────────────────────────────
// A per-run sandbox home. Set BEFORE any test module is imported, so a module
// that still computes a home-rooted constant at load time computes it against
// the sandbox (as long as it resolves through `userHome()` / `$XDG_*`).
function makeSandboxHome(): string {
  const base = tmpdir();
  try {
    return mkdtempSync(join(base, "arc-test-home-"));
  } catch (err: unknown) {
    // arc#421 round 4 (minor): a bare `mkdtempSync` throw here took the WHOLE
    // suite down with 529 spurious failures and a stack trace pointing at a
    // preload, for nothing worse than a `$TMPDIR` that does not exist. Say
    // what is wrong instead.
    throw new Error(
      `real-home guard: cannot create a sandbox home under "${base}" ` +
        `(${err instanceof Error ? err.message : String(err)}).\n` +
        `  $TMPDIR is "${process.env.TMPDIR ?? "(unset)"}". Every test in this ` +
        `suite runs against a temp home; without one the suite would write into ` +
        `the operator's real home, so it refuses to start.\n` +
        `  Fix: point $TMPDIR at a directory that exists, or unset it to use the ` +
        `system default.`,
      { cause: err },
    );
  }
}

const SANDBOX_HOME = makeSandboxHome();
mkdirSync(join(SANDBOX_HOME, ".config"), { recursive: true });
process.env.HOME = SANDBOX_HOME;
process.env.XDG_CONFIG_HOME = join(SANDBOX_HOME, ".config");
process.env.XDG_DATA_HOME = join(SANDBOX_HOME, ".local", "share");
process.env.XDG_STATE_HOME = join(SANDBOX_HOME, ".local", "state");
process.env.XDG_CACHE_HOME = join(SANDBOX_HOME, ".cache");
// A dev root is never inferred (arc#423/#426) — but a test that SETS one must
// not inherit the operator's. Pin it into the sandbox so an un-pinned
// `generateRules` call writes there instead of into `~/Developer`.
process.env.BLUEPRINT_DEV_ROOT = join(SANDBOX_HOME, "Developer");
mkdirSync(process.env.BLUEPRINT_DEV_ROOT, { recursive: true });
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
  const report = formatLeakReport(diffSnapshots(BEFORE, snapshotRoots(WATCHED)), REAL_HOME);
  if (!report) return;
  process.stderr.write(report);
  process.exitCode = 1;
};

let checked = false;
const checkOnce = (): void => {
  if (checked) return;
  checked = true;
  check();
};

// The final walk is the expensive one — ~350k files with nothing pruned over a
// real destination — so it gets its own timeout rather than tripping bun's
// 5s hook default and failing the run it was meant to verify.
const CHECK_TIMEOUT_MS = 300_000;

afterAll(checkOnce, CHECK_TIMEOUT_MS);
process.on("exit", checkOnce);
