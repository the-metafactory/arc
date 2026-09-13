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
export const WATCHED: WatchedRoot[] = [
  {
    path: h(".config", "metafactory"),
    why: "agent provision sidecars, principals.json, keys/ — the incident's blast radius",
    // The blueprint API server rewrites its pid file and serve log continuously
    // while it runs, so on a box with it up a run that touched nothing would
    // still trip the guard. Nothing arc's tests write lands here.
    exclude: [h(".config", "metafactory", "blueprint")],
  },
  { path: h(".config", "cortex"), why: "cortex agents/ — written by the identity provisioner" },
  { path: h(".config", "nats"), why: "nsc store + *.creds — written by the real nsc binary" },
  { path: h(".config", "nsc"), why: "alternate nsc store location" },
  { path: h(".local", "share", "metafactory"), why: "XDG data root for installed packages" },
  { path: h(".local", "share", "nats"), why: "XDG data root for nsc keystores" },
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
    // Bounded, and the bound is exactly arc's reach rather than a convenience.
    // `findConsumerRepos` enumerates ONE level below `BLUEPRINT_DEV_ROOT` and
    // `generateRules` writes at that repo's root, so a write lands at
    // `<root>/<repo>/CLAUDE.md`. Depth 2 also covers a dev root pointed one
    // level in (`~/Developer/<group>/<repo>/CLAUDE.md`), which is how this
    // machine's worktrees are laid out. No path exclusions: everything in
    // range is watched.
    maxDirDepth: 2,
  },
];

const BEFORE = snapshotRoots(WATCHED);

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

afterAll(checkOnce);
process.on("exit", checkOnce);
