/**
 * The snapshot/diff engine behind the real-home guard — pure, injectable, and
 * unit-testable, so the thing that is supposed to catch a leak is itself under
 * test rather than trusted.
 *
 * `real-home-guard.ts` is the `bun test` preload that points this at the
 * operator's actual home. Everything here takes its roots as an argument.
 *
 * ── Why the budget is PER ROOT (arc#421 round 3) ────────────────────────────
 *
 * Round 2 shipped one `MAX_ENTRIES = 20_000` counter shared by every root and
 * checked at the top of the walk. On a real developer box the first root,
 * `~/.config/metafactory`, holds 124,545 files because every installed
 * package's `node_modules` lives under it. The budget was therefore gone
 * before the walk reached `cortex`, `nats`, or anything after it: both
 * snapshots were equally blind, the diff came back empty, and the guard
 * reported success. An injected write to `nats` and to `cortex` — the two
 * roots the incident actually hit — went uncaught.
 *
 * Three changes make the budget bound what it claims to bound:
 *
 *  1. **Per root.** One root's size can no longer consume another's walk.
 *  2. **`node_modules` is pruned** everywhere beneath every root. It is never
 *     a destination arc writes to, and it is the entire reason the old budget
 *     ran out: pruning it takes `~/.config/metafactory` from 124,545 files to
 *     10,716.
 *  3. **Exhaustion is a LOUD FAILURE, not an early return.** A blind root is
 *     reported by name and fails the run. A guard that goes quiet because it
 *     ran out of budget is worse than no guard, because the silence reads as
 *     a pass.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directory names never walked, under any root. */
export const PRUNED_DIR_NAMES: readonly string[] = ["node_modules"];

/**
 * Default per-root file budget.
 *
 * Sized against the measured worst case on a developer box with `node_modules`
 * pruned — `~/.local/share/metafactory` at 14,997 files — with enough headroom
 * that ordinary growth does not trip it, and low enough that a test which
 * explodes a tree inside a watched root still gets caught.
 */
export const DEFAULT_BUDGET = 60_000;

export interface WatchedRoot {
  /** Absolute path to watch. */
  readonly path: string;
  /** Why this root is watched — printed when it goes blind. */
  readonly why: string;
  /**
   * Absolute subtrees skipped entirely. Use for churn a LIVE process owns,
   * never to make a root cheap to walk — that is what `maxDirDepth` is for,
   * and it states its bound instead of hiding it.
   */
  readonly exclude?: readonly string[];
  /**
   * Directory levels to descend below the root; the root itself is depth 0.
   * Omit for an unbounded walk. A bounded root is watched EXACTLY as deep as
   * arc's own writer can reach into it — see the `~/Developer` entry in
   * `real-home-guard.ts`.
   */
  readonly maxDirDepth?: number;
  /** Per-root override of {@link DEFAULT_BUDGET}. */
  readonly budget?: number;
}

export interface RootSnapshot {
  readonly root: string;
  readonly why: string;
  /** `path -> "<size>:<mtimeMs>"` for every file walked. */
  readonly files: Map<string, string>;
  /** True when the budget ran out — this root's result cannot be trusted. */
  readonly exhausted: boolean;
  readonly budget: number;
}

export type Snapshot = readonly RootSnapshot[];

export interface SnapshotDiff {
  readonly added: string[];
  readonly changed: string[];
  readonly removed: string[];
  /** Roots whose snapshot ran out of budget, on either side of the diff. */
  readonly blind: { root: string; why: string; budget: number }[];
}

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Walk one root, honouring its prune list, exclusions, depth cap and budget. */
export function snapshotRoot(root: WatchedRoot): RootSnapshot {
  const budget = root.budget ?? DEFAULT_BUDGET;
  const files = new Map<string, string>();
  let exhausted = false;

  const walk = (dir: string, depth: number): void => {
    if (exhausted) return;
    if (root.exclude?.some((ex) => isUnder(dir, ex))) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or gone — nothing to compare
    }

    for (const entry of entries) {
      if (exhausted) return;
      const full = join(dir, entry.name);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (PRUNED_DIR_NAMES.includes(entry.name)) continue;
        if (root.maxDirDepth !== undefined && depth >= root.maxDirDepth) continue;
        walk(full, depth + 1);
        continue;
      }

      if (files.size >= budget) {
        exhausted = true;
        return;
      }
      try {
        const st = statSync(full, { throwIfNoEntry: false });
        files.set(full, st ? `${st.size}:${st.mtimeMs}` : "dangling");
      } catch {
        files.set(full, "unstattable");
      }
    }
  };

  if (existsSync(root.path)) walk(root.path, 0);
  return { root: root.path, why: root.why, files, exhausted, budget };
}

export function snapshotRoots(roots: readonly WatchedRoot[]): Snapshot {
  return roots.map(snapshotRoot);
}

/**
 * Diff two snapshots taken over the SAME root list.
 *
 * A root that exhausted its budget on either side is reported in `blind`
 * rather than silently contributing an empty diff.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const blind: SnapshotDiff["blind"] = [];

  const beforeByRoot = new Map(before.map((s) => [s.root, s]));

  for (const post of after) {
    const pre = beforeByRoot.get(post.root);
    if (post.exhausted || pre?.exhausted) {
      blind.push({ root: post.root, why: post.why, budget: post.budget });
      continue;
    }
    if (!pre) continue;

    for (const [path, stamp] of post.files) {
      const was = pre.files.get(path);
      if (was === undefined) added.push(path);
      else if (was !== stamp) changed.push(path);
    }
    for (const path of pre.files.keys()) if (!post.files.has(path)) removed.push(path);
  }

  return { added, changed, removed, blind };
}

const RED = "[31m";
const RESET = "[0m";

function list(label: string, paths: string[]): string {
  if (!paths.length) return "";
  const shown = paths.slice(0, 40).map((p) => `    ${p}`).join("\n");
  const more = paths.length > 40 ? `\n    … and ${paths.length - 40} more` : "";
  return `\n  ${label} (${paths.length}):\n${shown}${more}`;
}

/**
 * Render a diff as an operator-facing failure, or `null` when the run was
 * clean AND no root went blind.
 */
export function formatLeakReport(diff: SnapshotDiff, home: string): string | null {
  const touched = diff.added.length + diff.changed.length + diff.removed.length;
  if (touched === 0 && diff.blind.length === 0) return null;

  const parts: string[] = [];

  if (diff.blind.length > 0) {
    parts.push(
      `\n${RED}✗ REAL-HOME GUARD WENT BLIND — a watched root exceeded its walk budget.${RESET}\n` +
        `  The guard cannot claim this run was clean: the roots below were only\n` +
        `  partially walked, so a write inside them would not have been seen.\n` +
        `  Raise that root's budget, prune what is not a destination, or cap its\n` +
        `  depth — do not leave it blind.` +
        diff.blind
          .map((b) => `\n    ${b.root} (budget ${b.budget}) — ${b.why}`)
          .join(""),
    );
  }

  if (touched > 0) {
    parts.push(
      `\n${RED}✗ REAL-HOME LEAK — this test run modified the operator's home directory.${RESET}\n` +
        `  Home: ${home}\n` +
        `  A test resolved a path through a raw os.homedir(), or spawned a child\n` +
        `  process without passing the current env, instead of an injected root or\n` +
        `  src/lib/user-home.ts's userHome(). Find it, pass the root explicitly,\n` +
        `  and re-run. Nothing has been deleted — decide for yourself what is test\n` +
        `  residue and what is yours.` +
        list("added", diff.added) +
        list("changed", diff.changed) +
        list("removed", diff.removed),
    );
  }

  return `${parts.join("\n")}\n`;
}
