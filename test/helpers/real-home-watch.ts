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
 *  2. **Exhaustion is a LOUD FAILURE, not an early return.** A blind root is
 *     reported by name and fails the run. A guard that goes quiet because it
 *     ran out of budget is worse than no guard, because the silence reads as
 *     a pass.
 *
 * ── Why `node_modules` is no longer pruned globally (arc#421 round 4, MAJOR A)
 *
 * Round 3 pruned every `node_modules` beneath every root, on the stated ground
 * that it "is never a destination arc writes to". That was **false**, and
 * falsest exactly where it mattered: `installNodeDependencies` runs
 * `bun install` inside `~/.local/share/metafactory/arc/repos/<pkg>` and
 * `~/.config/metafactory/pkg/repos/<pkg>`, both inside watched roots. The one
 * spawn site round 3 left un-`env`'d wrote into precisely the tree the guard
 * could not see, and `formatLeakReport` returned `null`.
 *
 * Pruning is therefore no longer a global constant. It is declared PER ROOT
 * and must carry a reason that is true of THAT root — see `WatchedRoot.prune`.
 * The two metafactory roots prune nothing. `~/Developer` still prunes
 * `node_modules`, because arc's only writer there (`generateRules`) writes
 * `CLAUDE.md` / `AGENTS.md` at a repo's ROOT and cannot land inside one.
 *
 * And a pruned directory is no longer skipped silently: a marker entry is
 * recorded for it, so a `node_modules` that APPEARS where none existed is
 * still reported by name.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Value recorded for a directory a root declines to descend into. Its presence
 * in the snapshot is what makes the skip STATED rather than silent: a pruned
 * directory that appears between two snapshots shows up as an addition.
 */
export const PRUNED_MARKER = "pruned-subtree";

/**
 * Default per-root file budget.
 *
 * Sized against the measured worst case on a developer box with NOTHING pruned
 * — `~/.local/share/metafactory` at 142,883 files — with enough headroom that
 * ordinary growth does not trip it, and low enough that a test which explodes
 * a tree inside a watched root still gets caught.
 */
export const DEFAULT_BUDGET = 300_000;

/** A declared prune: the directory names skipped, and why that is safe HERE. */
export interface PrunePolicy {
  readonly names: readonly string[];
  /**
   * Why arc's own writer for THIS root cannot land inside those directories.
   * A prune without a reason that is true of this root is how MAJOR A
   * happened.
   */
  readonly why: string;
}

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
   * Basenames skipped ANYWHERE beneath this root — for churn a live process
   * owns that is interleaved with arc's own destinations, so a subtree
   * exclusion would be too coarse. Same rule as `exclude`: never use it to
   * make a root cheap, and never on a name arc's own code can write.
   */
  readonly excludeNames?: readonly string[];
  /**
   * Directory levels to descend below the root; the root itself is depth 0.
   * Omit for an unbounded walk. A bounded root is watched EXACTLY as deep as
   * arc's own writer can reach into it — see the `~/Developer` entry in
   * `real-home-guard.ts`.
   */
  readonly maxDirDepth?: number;
  /** Per-root override of {@link DEFAULT_BUDGET}. */
  readonly budget?: number;
  /**
   * Directory names not descended into, declared PER ROOT with a reason.
   * Omit — the default — to walk everything. Never prune a directory arc's
   * own code can write into; that is the arc#421 round 4 MAJOR A defect.
   */
  readonly prune?: PrunePolicy;
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
      if (root.excludeNames?.includes(entry.name)) continue;
      const full = join(dir, entry.name);

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (root.prune?.names.includes(entry.name)) {
          // STATED, not silent: record the boundary so a pruned directory that
          // appears where none existed is still reported by name.
          if (files.size >= budget) {
            exhausted = true;
            return;
          }
          files.set(full, PRUNED_MARKER);
          continue;
        }
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
