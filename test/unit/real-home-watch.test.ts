/**
 * The guard's own test suite — arc#421 round 3.
 *
 * Round 2's guard was trusted on the strength of one fault injection, which
 * happened to land in the only root its shared budget got to walk. Everything
 * after that root was blind and the guard still reported a clean run. So the
 * detector is now a detector under test: each case below RED-FAILS against the
 * round-2 behaviour (one global `MAX_ENTRIES`, no pruning, silent early return,
 * no `~/.claude` or `~/Developer`).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  DEFAULT_BUDGET,
  PRUNED_DIR_NAMES,
  diffSnapshots,
  formatLeakReport,
  snapshotRoot,
  snapshotRoots,
  type WatchedRoot,
} from "../helpers/real-home-watch.js";
import { WATCHED } from "../helpers/real-home-guard.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "arc-guard-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(rel: string, body = "x"): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function fill(dir: string, count: number): void {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, dir, `f${i}`), "x");
}

// ---------------------------------------------------------------------------
// Item 1 — the budget must bound what it claims to bound.
// ---------------------------------------------------------------------------

describe("arc#421 — the walk budget is PER ROOT", () => {
  test("a huge first root does not blind a later one", () => {
    const big = join(root, "big");
    const small = join(root, "small");
    mkdirSync(small, { recursive: true });
    fill("big", 40);

    const roots: WatchedRoot[] = [
      { path: big, why: "the fat root", budget: 20 },
      { path: small, why: "the root the incident hit", budget: 20 },
    ];

    const before = snapshotRoots(roots);
    writeFileSync(join(small, "leaked.json"), "x");
    const diff = diffSnapshots(before, snapshotRoots(roots));

    // Round 2: `big` consumed the single shared counter, `small` returned
    // immediately on BOTH sides, and this diff was empty.
    expect(diff.added).toEqual([join(small, "leaked.json")]);
  });

  test("node_modules is pruned, so a real config root fits its budget", () => {
    expect(PRUNED_DIR_NAMES).toContain("node_modules");
    fill("pkg/repos/somepkg/node_modules", 500);
    file("agents/real.provision.json");

    const snap = snapshotRoot({ path: root, why: "config root", budget: 50 });
    expect(snap.exhausted).toBe(false);
    expect([...snap.files.keys()]).toEqual([join(root, "agents", "real.provision.json")]);
  });

  test("exhausting the budget is a LOUD failure, not a silent early return", () => {
    fill("noise", 30);
    const roots: WatchedRoot[] = [{ path: root, why: "a pathological tree", budget: 10 }];

    const snap = snapshotRoot(roots[0]);
    expect(snap.exhausted).toBe(true);

    const diff = diffSnapshots(snapshotRoots(roots), snapshotRoots(roots));
    expect(diff.blind.map((b) => b.root)).toEqual([root]);

    const report = formatLeakReport(diff, root);
    // Round 2: an exhausted walk returned early and the diff came back empty,
    // which the caller read as "clean".
    expect(report).not.toBeNull();
    expect(report).toContain("WENT BLIND");
    expect(report).toContain(root);
    expect(report).toContain("a pathological tree");
  });

  test("a clean run with every root inside budget reports nothing", () => {
    file("agents/a.json");
    const roots: WatchedRoot[] = [{ path: root, why: "config root" }];
    expect(formatLeakReport(diffSnapshots(snapshotRoots(roots), snapshotRoots(roots)), root)).toBeNull();
  });

  test("the default budget clears the measured worst case with headroom", () => {
    expect(DEFAULT_BUDGET).toBeGreaterThan(15_000);
  });
});

// ---------------------------------------------------------------------------
// Detection surface — added, changed, removed.
// ---------------------------------------------------------------------------

describe("arc#421 — the diff names what moved", () => {
  test("added, changed and removed are each reported by path", () => {
    const kept = file("keep.txt", "one");
    const doomed = file("doomed.txt");
    const roots: WatchedRoot[] = [{ path: root, why: "config root" }];
    const before = snapshotRoots(roots);

    writeFileSync(kept, "one-plus-more");
    rmSync(doomed);
    const born = file("born.txt");

    const diff = diffSnapshots(before, snapshotRoots(roots));
    expect(diff.added).toEqual([born]);
    expect(diff.changed).toEqual([kept]);
    expect(diff.removed).toEqual([doomed]);

    const report = formatLeakReport(diff, root)!;
    for (const p of [born, kept, doomed]) expect(report).toContain(p);
  });

  test("maxDirDepth bounds the walk at the stated depth and no deeper", () => {
    const roots: WatchedRoot[] = [{ path: root, why: "dev root", maxDirDepth: 2 }];
    const before = snapshotRoots(roots);
    const inRange = file("repo/CLAUDE.md");
    const alsoInRange = file("group/repo/AGENTS.md");
    file("group/repo/src/deep.ts");

    const diff = diffSnapshots(before, snapshotRoots(roots));
    expect(diff.added.sort()).toEqual([alsoInRange, inRange].sort());
  });
});

// ---------------------------------------------------------------------------
// Item 2 — the real watch list, and an attempted write in every root.
// ---------------------------------------------------------------------------

describe("arc#421 — every real-home destination arc can reach is watched", () => {
  const HOME = homedir();

  test.each([
    [".config/metafactory"],
    [".config/cortex"],
    [".config/nats"],
    [".local/share/metafactory"],
    // Round 2 watched neither of these two, and both were hit for real.
    [".claude"],
    ["Developer"],
  ])("%s is on the watch list", (rel) => {
    expect(WATCHED.map((w) => w.path)).toContain(join(HOME, rel));
  });

  /**
   * The injection matrix, run safely.
   *
   * Each row takes the REAL `WatchedRoot` config — its exclusions, its depth
   * cap, its budget — rebases it onto a temp directory, and writes the file
   * arc's own installer would drop there. The guard must name that path. A
   * root that is watched but configured so that arc's destination falls
   * outside the walk is exactly the failure round 2 shipped, and this catches
   * it without touching the operator's home.
   */
  test.each([
    [".config/metafactory", "agents/sage.provision.json"],
    [".config/metafactory", "principals.json"],
    [".config/metafactory", "keys/O/OABC.nk"],
    [".config/cortex", "agents/sage/agent.yaml"],
    [".config/nats", "nsc/nsc.json"],
    [".config/nats", "bot.creds"],
    [".config/nsc", "nsc.json"],
    [".local/share/metafactory", "arc/pkg/repos/pkg/file"],
    [".local/share/nats", "nsc/keys/O/OABC.nk"],
    [".nsc", "nsc.json"],
    [".sigstore", "root/tuf-repo-cdn.sigstore.dev.json"],
    [".claude", "skills/Foo/SKILL.md"],
    [".claude", "agents/foo.md"],
    [".claude", "commands/foo.md"],
    [".claude", "hooks/foo.ts"],
    [".claude", "rules/soma/CONTEXT.md"],
    [".claude", "settings.json"],
    [".claude", "CLAUDE.md"],
    ["Developer", "some-repo/CLAUDE.md"],
    ["Developer", "some-repo/AGENTS.md"],
    ["Developer", "arc-worktrees/wt/CLAUDE.md"],
  ])("a write to ~/%s/%s is refused by name", (rel, drop) => {
    const real = WATCHED.find((w) => w.path === join(HOME, rel));
    expect(real).toBeDefined();

    // Same config, rebased onto the sandbox — exclusions and all.
    const rebased: WatchedRoot = {
      ...real!,
      path: root,
      exclude: real!.exclude?.map((e) => join(root, relative(real!.path, e))),
    };
    mkdirSync(root, { recursive: true });

    const before = snapshotRoots([rebased]);
    const landed = file(drop);
    const diff = diffSnapshots(before, snapshotRoots([rebased]));

    expect(diff.blind).toEqual([]);
    expect(diff.added).toContain(landed);
    expect(formatLeakReport(diff, root)).toContain(landed);
  });

  test("~/Developer is watched with no path exclusions", () => {
    const dev = WATCHED.find((w) => w.path === join(HOME, "Developer"))!;
    expect(dev.exclude ?? []).toEqual([]);
    expect(dev.maxDirDepth).toBe(2);
  });

  test("~/.claude's exclusions are narrow — no arc install destination is inside one", () => {
    const claude = WATCHED.find((w) => w.path === join(HOME, ".claude"))!;
    expect(claude.exclude?.length).toBeGreaterThan(0);
    for (const dest of ["skills", "agents", "commands", "hooks", "rules", "settings.json", "CLAUDE.md"]) {
      const path = join(claude.path, dest);
      expect(claude.exclude!.some((e) => path === e || path.startsWith(`${e}/`))).toBe(false);
    }
  });
});
