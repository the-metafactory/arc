import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveCortexConfigDir,
  cortexConfigDirOverride,
  cortexCanonicalConfigDir,
  type CortexConfigDirSeam,
} from "../../src/lib/hosts/cortex-config-dir.js";

/**
 * G-18 (EPIC cortex#1867) — drift oracle for arc's existence-gated cortex
 * config-dir resolver.
 *
 * arc provisions INTO cortex's config tree, so arc MUST resolve that dir the
 * EXACT same way the live cortex does — any drift misprovisions the box. This
 * suite pins arc's `resolveCortexConfigDir` against an INDEPENDENT
 * reimplementation of cortex's `resolveConfigDir`
 * (`src/common/config/config-path.ts` on cortex origin/main, XDG wave-4
 * cortex#1869 — verified against commit tree b7a0e3f0), across every
 * tree-presence stage. If cortex changes its precedence, THIS ORACLE must be
 * updated in lockstep — that is the whole point: a byte-diff here is the alarm.
 *
 * The reference precedence (cortex's `resolveConfigDir`):
 *   1. `$CORTEX_CONFIG_DIR` (trimmed; blank ⇒ unset) — verbatim, no probe.
 *   2. canonical `~/.config/metafactory/cortex` — if it exists.
 *   3. legacy flat `~/.config/cortex` — if it exists.
 *   4. legacy `~/.config/grove` — if it exists.
 *   5. canonical `~/.config/metafactory/cortex` — fresh-host default.
 */

/** Independent reference implementation of cortex's `resolveConfigDir`. */
function cortexResolveConfigDirOracle(seam: CortexConfigDirSeam): string {
  const home = seam.home!;
  const env = seam.env ?? {};
  // cortex readDirEnv: trim; blank/whitespace ⇒ unset.
  const rawOverride = env.CORTEX_CONFIG_DIR;
  const override =
    rawOverride !== undefined && rawOverride.trim().length > 0
      ? rawOverride.trim()
      : undefined;
  const canonical = override ?? join(home, ".config", "metafactory", "cortex");
  if (override !== undefined) return canonical; // self-contained root, no probe
  if (existsSync(canonical)) return canonical;
  const legacyCortex = join(home, ".config", "cortex");
  if (existsSync(legacyCortex)) return legacyCortex;
  const grove = join(home, ".config", "grove");
  if (existsSync(grove)) return grove;
  return canonical;
}

let tmps: string[] = [];
function scratch(): string {
  const t = mkdtempSync(join(tmpdir(), "arc-cortex-cfgdir-"));
  tmps.push(t);
  return t;
}
afterEach(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
  tmps = [];
});

function plant(home: string, ...rel: string[][]) {
  for (const segs of rel) mkdirSync(join(home, ...segs), { recursive: true });
}

describe("resolveCortexConfigDir — drift oracle vs cortex resolveConfigDir", () => {
  // Each stage plants a specific tree combination, then asserts arc's resolver
  // === the independent cortex oracle, on the SAME scratch home.
  const stages: {
    name: string;
    trees: string[][];
    env?: Record<string, string | undefined>;
    expect: (home: string) => string;
  }[] = [
    {
      name: "neither/fresh → canonical default",
      trees: [],
      expect: (h) => join(h, ".config", "metafactory", "cortex"),
    },
    {
      name: "canonical-only → canonical",
      trees: [[".config", "metafactory", "cortex"]],
      expect: (h) => join(h, ".config", "metafactory", "cortex"),
    },
    {
      name: "legacy-only → legacy flat cortex",
      trees: [[".config", "cortex"]],
      expect: (h) => join(h, ".config", "cortex"),
    },
    {
      name: "grove-only → grove",
      trees: [[".config", "grove"]],
      expect: (h) => join(h, ".config", "grove"),
    },
    {
      name: "legacy + grove → legacy flat cortex wins (fallback order)",
      trees: [[".config", "cortex"], [".config", "grove"]],
      expect: (h) => join(h, ".config", "cortex"),
    },
    {
      name: "canonical + legacy + grove → canonical wins",
      trees: [
        [".config", "metafactory", "cortex"],
        [".config", "cortex"],
        [".config", "grove"],
      ],
      expect: (h) => join(h, ".config", "metafactory", "cortex"),
    },
    {
      name: "$CORTEX_CONFIG_DIR set → verbatim, NO legacy probe even if trees exist",
      trees: [[".config", "cortex"], [".config", "grove"]],
      env: { CORTEX_CONFIG_DIR: "/srv/cortex-cfg" },
      expect: () => "/srv/cortex-cfg",
    },
    {
      name: "blank $CORTEX_CONFIG_DIR → treated as unset (legacy fallback reachable)",
      trees: [[".config", "cortex"]],
      env: { CORTEX_CONFIG_DIR: "   " },
      expect: (h) => join(h, ".config", "cortex"),
    },
  ];

  for (const stage of stages) {
    test(stage.name, () => {
      const home = scratch();
      plant(home, ...stage.trees);
      const seam: CortexConfigDirSeam = { home, env: stage.env ?? {} };
      const got = resolveCortexConfigDir(seam);
      // 1) Matches the independent cortex oracle.
      expect(got).toBe(cortexResolveConfigDirOracle(seam));
      // 2) Matches the explicit expectation (double-entry bookkeeping).
      expect(got).toBe(stage.expect(home));
    });
  }
});

describe("cortexConfigDirOverride — readDirEnv semantics (mirrors cortex)", () => {
  test("unset → undefined", () => {
    expect(cortexConfigDirOverride({ home: "/h", env: {} })).toBeUndefined();
  });
  test("blank/whitespace → undefined (never a literal relative dir)", () => {
    expect(
      cortexConfigDirOverride({ home: "/h", env: { CORTEX_CONFIG_DIR: "" } }),
    ).toBeUndefined();
    expect(
      cortexConfigDirOverride({ home: "/h", env: { CORTEX_CONFIG_DIR: "  " } }),
    ).toBeUndefined();
  });
  test("set → trimmed verbatim", () => {
    expect(
      cortexConfigDirOverride({ home: "/h", env: { CORTEX_CONFIG_DIR: " /a/b " } }),
    ).toBe("/a/b");
  });
});

describe("cortexCanonicalConfigDir", () => {
  test("no override → ~/.config/metafactory/cortex (hardcoded .config, NOT $XDG_CONFIG_HOME)", () => {
    // Deliberately IGNORES $XDG_CONFIG_HOME to byte-match cortex, which does not
    // consult it for the config dir.
    expect(
      cortexCanonicalConfigDir({
        home: "/h",
        env: { XDG_CONFIG_HOME: "/xdg/config" },
      }),
    ).toBe(join("/h", ".config", "metafactory", "cortex"));
  });
  test("override → verbatim", () => {
    expect(
      cortexCanonicalConfigDir({ home: "/h", env: { CORTEX_CONFIG_DIR: "/x" } }),
    ).toBe("/x");
  });
});
