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
  PRUNED_MARKER,
  diffSnapshots,
  formatLeakReport,
  snapshotRoot,
  snapshotRoots,
  type WatchedRoot,
} from "../helpers/real-home-watch.js";
import { NAMED_BUT_NEVER_WRITTEN, WATCHED } from "../helpers/real-home-guard.js";

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

  test("arc#421 MAJOR A — an UNPRUNED root sees writes inside node_modules", () => {
    // Round 3 pruned `node_modules` under every root on the stated ground that
    // arc never writes there. `installNodeDependencies` runs `bun install`
    // inside `<root>/repos/<pkg>`, so the claim was false exactly where it
    // mattered — and the guard returned `null` for a real destination.
    const roots: WatchedRoot[] = [{ path: root, why: "config root" }];
    mkdirSync(join(root, "repos", "somepkg", "node_modules"), { recursive: true });
    const before = snapshotRoots(roots);
    file("repos/somepkg/node_modules/left-behind/index.js");

    const diff = diffSnapshots(before, snapshotRoots(roots));
    expect(diff.added).toContain(
      join(root, "repos", "somepkg", "node_modules", "left-behind", "index.js"),
    );
    expect(formatLeakReport(diff, root)).toContain("node_modules");
  });

  test("a DECLARED prune skips the subtree — but records a marker, not silence", () => {
    // `~/Developer` still prunes, because `generateRules` writes at a repo's
    // ROOT and cannot land inside a node_modules. The marker keeps even that
    // skip visible: a node_modules that APPEARS is still an addition.
    const roots: WatchedRoot[] = [
      {
        path: root,
        why: "a dev root",
        prune: { names: ["node_modules"], why: "generateRules writes at a repo root only" },
      },
    ];
    fill("repo-a/node_modules", 500);
    file("repo-a/CLAUDE.md");

    const snap = snapshotRoot({ ...roots[0], budget: 50 });
    expect(snap.exhausted).toBe(false);
    expect(snap.files.get(join(root, "repo-a", "node_modules"))).toBe(PRUNED_MARKER);

    const before = snapshotRoots(roots);
    mkdirSync(join(root, "repo-b", "node_modules"), { recursive: true });
    expect(diffSnapshots(before, snapshotRoots(roots)).added).toContain(
      join(root, "repo-b", "node_modules"),
    );
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
    // Measured UNPRUNED on a developer box: `~/.local/share/metafactory` at
    // 142,883 files. The budget has to clear that, or the roots the incident
    // hit go blind the moment pruning is removed.
    expect(DEFAULT_BUDGET).toBeGreaterThan(150_000);
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
    // arc#421 round 4 (MAJOR B): destinations that resolve through a raw
    // `homedir()` with no seam, and so were unwatched while this suite's name
    // claimed otherwise.
    [".local/bin"],
    ["Library/LaunchAgents"],
    [".config/systemd/user"],
    [".bun"],
    [".local/state/metafactory"],
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
    [".local/bin", "somepkg"],
    ["Library/LaunchAgents", "ai.meta-factory.somepkg.plist"],
    [".config/systemd/user", "somepkg.service"],
    [".bun", "install/cache/left-behind@1.0.0/index.js"],
    [".local/state/metafactory", "somepkg/log/out.log"],
    // arc#421 round 4 (MAJOR A): `installNodeDependencies` runs `bun install`
    // inside a package checkout under BOTH metafactory roots. Round 3 pruned
    // `node_modules` globally, so the guard returned `null` for exactly this.
    [".local/share/metafactory", "arc/repos/pkg/node_modules/dep/index.js"],
    [".config/metafactory", "pkg/repos/pkg/node_modules/dep/index.js"],
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

  test("arc#421 MAJOR B — the ~/Developer bound covers the reach a test run has", () => {
    // The bound is stated, not claimed to be total: `findConsumerRepos`'s
    // `cwd` origin has no depth limit. What IS containable is the reach a test
    // run has, and that has to be checked rather than asserted in a comment —
    // `process.cwd()` is where an un-seamed `generateRules` would write.
    const dev = WATCHED.find((w) => w.path === join(HOME, "Developer"))!;
    const cwd = process.cwd();
    if (cwd === dev.path || cwd.startsWith(`${dev.path}/`)) {
      const depth = relative(dev.path, cwd).split("/").filter(Boolean).length;
      expect(depth).toBeLessThanOrEqual(dev.maxDirDepth!);
    }
    // And a scan origin can never point at the real tree: the preload pins it.
    expect(process.env.BLUEPRINT_DEV_ROOT).toBeDefined();
    expect(process.env.BLUEPRINT_DEV_ROOT!.startsWith(HOME + "/Developer")).toBe(false);
  });

  test("arc#421 MAJOR A — neither metafactory root prunes anything", () => {
    // `installNodeDependencies` runs `bun install` inside package checkouts
    // under both. A prune here is a blind spot over a real destination.
    for (const rel of [".config/metafactory", ".local/share/metafactory"]) {
      const w = WATCHED.find((x) => x.path === join(HOME, rel))!;
      expect(w.prune).toBeUndefined();
    }
  });

  test("every declared prune carries a reason", () => {
    for (const w of WATCHED) {
      if (!w.prune) continue;
      expect(w.prune.names.length).toBeGreaterThan(0);
      expect(w.prune.why.length).toBeGreaterThan(20);
    }
  });

  test("the one destination arc NAMES but never creates is recorded as a decision", () => {
    // `~/Library/Logs/<pkg>` is substituted into a plist as {{LOG_DIR}}; arc
    // has no mkdir for it. Its absence from WATCHED is a decision with a
    // reason, not an oversight — which is the difference this round is about.
    expect(NAMED_BUT_NEVER_WRITTEN).toContain(join(HOME, "Library", "Logs"));
    for (const p of NAMED_BUT_NEVER_WRITTEN) {
      expect(WATCHED.map((w) => w.path)).not.toContain(p);
    }
  });

  test("~/.config/cortex's exclusions are narrow — no arc destination is inside one", () => {
    const cortex = WATCHED.find((w) => w.path === join(HOME, ".config", "cortex"))!;
    for (const dest of ["agents", "agents.d", "cortex.yaml", "agents/sage/agent.yaml"]) {
      const path = join(cortex.path, dest);
      expect((cortex.exclude ?? []).some((e) => path === e || path.startsWith(`${e}/`))).toBe(false);
    }
    // And no basename exclusion may shadow something arc writes. arc's own
    // identity provisioner CREATES `state.sqlite`, so only the sqlite journal
    // sidecars may be skipped — never the database file itself.
    expect(cortex.excludeNames).toEqual(["state.sqlite-wal", "state.sqlite-shm"]);
    expect(cortex.excludeNames).not.toContain("state.sqlite");
  });

  test("a basename exclusion never hides a database file, only its journals", () => {
    // The distinction that keeps this exclusion honest: arc writes
    // `state.sqlite`; the daemon writes its `-wal`. Skipping the pair is safe,
    // skipping the database would hide a real destination.
    for (const w of WATCHED) {
      for (const name of w.excludeNames ?? []) {
        expect(name.endsWith("-wal") || name.endsWith("-shm")).toBe(true);
      }
    }
  });

  test("a basename exclusion skips that name anywhere, and nothing else", () => {
    const roots: WatchedRoot[] = [
      { path: root, why: "cortex", excludeNames: ["state.sqlite-wal"] },
    ];
    const before = snapshotRoots(roots);
    file("agents/sage/state.sqlite-wal");
    const kept = file("agents/sage/agent.yaml");
    const diff = diffSnapshots(before, snapshotRoots(roots));
    expect(diff.added).toEqual([kept]);
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
