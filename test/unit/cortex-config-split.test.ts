import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectCortexLayout,
  resolveCortexConfigRoot,
  buildCortexInstallSteering,
  CORTEX_LAYOUT_MARKER,
} from "../../src/lib/hosts/cortex-config-split.js";
import { resolveCortexConfigDir } from "../../src/lib/hosts/cortex-config-dir.js";

/**
 * S1 (arc#244 / cortex#1133) — config-split stack targeting for `arc install`.
 *
 * These tests pin the resolution + detection contract that lets `arc install`
 * target a config-split cortex stack (`~/.config/cortex/<stack>/`) instead of
 * the legacy single-file root (`~/.config/cortex`). The detection mirrors
 * cortex's own convention (cortex `src/common/config/loader.ts`):
 *   - LAYOUT_MARKER = `system/system.yaml` selects the split layout
 *   - `--config` points at a POINTER (sentinel) file whose DIRNAME is the
 *     config dir (the pointer's contents are ignored; its basename names the
 *     PID file).
 */

/** Scaffold a config-split stack dir (with the system/system.yaml marker). */
function scaffoldSplitStack(root: string, slug: string): string {
  const stackDir = join(root, slug);
  mkdirSync(join(stackDir, "system"), { recursive: true });
  writeFileSync(join(stackDir, "system", "system.yaml"), "nats: {}\n");
  mkdirSync(join(stackDir, "stacks"), { recursive: true });
  writeFileSync(join(stackDir, "stacks", `${slug}.yaml`), `stack:\n  id: ${slug}\n`);
  // Pointer (sentinel) file — its dirname selects the layout, basename names PID.
  writeFileSync(join(stackDir, `${slug}.yaml`), "# pointer\n");
  return stackDir;
}

describe("CORTEX_LAYOUT_MARKER", () => {
  test("mirrors cortex's system/system.yaml marker", () => {
    // Pinned against cortex src/common/config/loader.ts LAYOUT_MARKER.
    expect(CORTEX_LAYOUT_MARKER).toBe(join("system", "system.yaml"));
  });
});

describe("detectCortexLayout", () => {
  test("returns 'config-split' when system/system.yaml marker present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-css-detect-"));
    try {
      const stackDir = scaffoldSplitStack(join(tmp, ".config", "cortex"), "meta-factory");
      expect(detectCortexLayout(stackDir)).toBe("config-split");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 'legacy' when no marker present (bare dir)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-css-legacy-"));
    try {
      const configRoot = join(tmp, ".config", "cortex");
      mkdirSync(configRoot, { recursive: true });
      writeFileSync(join(configRoot, "cortex.yaml"), "version: 1\n");
      expect(detectCortexLayout(configRoot)).toBe("legacy");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 'legacy' for a non-existent dir (nothing to detect)", () => {
    expect(detectCortexLayout("/tmp/does-not-exist-arc-css")).toBe("legacy");
  });
});

describe("resolveCortexConfigRoot", () => {
  const home = "/home/tester";

  test("no flag → undefined (caller keeps legacy ~/.config/cortex default)", () => {
    const r = resolveCortexConfigRoot({ home });
    expect(r.configRoot).toBeUndefined();
    expect(r.source).toBe("default");
  });

  test("--stack <name> → <existence-gated cortex dir>/<name> (canonical on a fresh/scratch box)", () => {
    // Scratch home has NO cortex trees on disk → the existence-gated base is the
    // canonical `metafactory/cortex` default (matching a migrated/fresh cortex).
    const r = resolveCortexConfigRoot({ stack: "meta-factory", home, env: {} });
    expect(r.configRoot).toBe(
      join(home, ".config", "metafactory", "cortex", "meta-factory"),
    );
    expect(r.source).toBe("stack");
  });

  test("--config-dir <dir> (a real directory) → that directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-css-cd-dir-"));
    try {
      const stackDir = scaffoldSplitStack(join(tmp, ".config", "cortex"), "research");
      const r = resolveCortexConfigRoot({ configDir: stackDir, home });
      expect(r.configRoot).toBe(stackDir);
      expect(r.source).toBe("config-dir");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--config-dir <pointer-file> → its dirname (cortex pointer convention)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-css-cd-ptr-"));
    try {
      const stackDir = scaffoldSplitStack(join(tmp, ".config", "cortex"), "research");
      const pointer = join(stackDir, "research.yaml");
      const r = resolveCortexConfigRoot({ configDir: pointer, home });
      // Pointer file's DIRNAME is the config dir.
      expect(r.configRoot).toBe(stackDir);
      expect(r.source).toBe("config-dir");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--config-dir expands a leading ~ to home", () => {
    const r = resolveCortexConfigRoot({
      configDir: "~/.config/cortex/meta-factory",
      home,
    });
    expect(r.configRoot).toBe(join(home, ".config", "cortex", "meta-factory"));
  });

  test("--stack expands relative to home even when home is overridden", () => {
    const r = resolveCortexConfigRoot({
      stack: "work",
      home: "/custom/home",
      env: {},
    });
    // Scratch home → canonical base; the stack name hangs off the home override.
    expect(r.configRoot).toBe("/custom/home/.config/metafactory/cortex/work");
  });

  test("rejects --config-dir together with --stack (ambiguous)", () => {
    expect(() =>
      resolveCortexConfigRoot({ configDir: "/x", stack: "y", home }),
    ).toThrow(/both --config-dir and --stack/i);
  });

  test("rejects an empty / whitespace-only --config-dir (no CWD-relative scatter)", () => {
    // Echo review r3434847629: an unset shell var → `--config-dir ""` must NOT
    // degrade to configRoot:"" (→ cortexPaths agentsDir:"agents.d", CWD-relative).
    expect(() => resolveCortexConfigRoot({ configDir: "", home })).toThrow(
      /--config-dir/i,
    );
    expect(() => resolveCortexConfigRoot({ configDir: "   ", home })).toThrow(
      /--config-dir/i,
    );
  });

  test("normalizes a relative --config-dir to an absolute path", () => {
    const r = resolveCortexConfigRoot({ configDir: "./some/stack", home });
    // Must be absolute (resolve() against CWD), never a bare relative segment.
    expect(r.configRoot).toBe(join(process.cwd(), "some", "stack"));
    expect(r.configRoot!.startsWith("/")).toBe(true);
    expect(r.source).toBe("config-dir");
  });

  test("rejects an empty --stack name", () => {
    expect(() => resolveCortexConfigRoot({ stack: "   ", home })).toThrow(
      /stack name/i,
    );
  });

  test("rejects a --stack name with path separators (traversal guard)", () => {
    expect(() => resolveCortexConfigRoot({ stack: "../evil", home })).toThrow(
      /stack name/i,
    );
    expect(() => resolveCortexConfigRoot({ stack: "a/b", home })).toThrow(
      /stack name/i,
    );
  });

  test("default home is the real homedir() when not overridden", () => {
    // Deterministic regardless of the box's on-disk cortex trees: the stack
    // base is whatever the shared existence-gated resolver returns for the real
    // home/env, so this pins the home-defaulting wiring, not the tree state.
    const r = resolveCortexConfigRoot({ stack: "s" });
    expect(r.configRoot).toBe(join(resolveCortexConfigDir(), "s"));
  });

  test("--stack base is existence-gated: legacy ~/.config/cortex wins when present (byte-identical pre-cutover)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-css-stack-legacy-"));
    try {
      // Plant the legacy flat cortex tree, NOT the canonical one.
      mkdirSync(join(tmp, ".config", "cortex"), { recursive: true });
      const r = resolveCortexConfigRoot({ stack: "meta-factory", home: tmp, env: {} });
      expect(r.configRoot).toBe(join(tmp, ".config", "cortex", "meta-factory"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--stack base is existence-gated: canonical metafactory/cortex wins when present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-css-stack-canonical-"));
    try {
      // Plant BOTH trees — canonical must win (matches a migrated cortex).
      mkdirSync(join(tmp, ".config", "cortex"), { recursive: true });
      mkdirSync(join(tmp, ".config", "metafactory", "cortex"), { recursive: true });
      const r = resolveCortexConfigRoot({ stack: "meta-factory", home: tmp, env: {} });
      expect(r.configRoot).toBe(
        join(tmp, ".config", "metafactory", "cortex", "meta-factory"),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--stack base honors an explicit $CORTEX_CONFIG_DIR override (verbatim base)", () => {
    const r = resolveCortexConfigRoot({
      stack: "meta-factory",
      home,
      env: { CORTEX_CONFIG_DIR: "/srv/cortex-cfg" },
    });
    expect(r.configRoot).toBe(join("/srv/cortex-cfg", "meta-factory"));
  });
});

describe("buildCortexInstallSteering (CLI → install() wiring)", () => {
  const home = "/home/tester";

  test("no flag → no hostOverrides, empty env (byte-identical legacy default)", () => {
    const s = buildCortexInstallSteering({ home });
    expect(s.hostOverrides).toBeUndefined();
    expect(s.cortexConfigEnv).toEqual({});
    expect(s.resolved.source).toBe("default");
  });

  test("--stack → cortex.configRoot override + CORTEX_CONFIG env, creds NOT overridden", () => {
    const s = buildCortexInstallSteering({ stack: "meta-factory", home, env: {} });
    // Scratch home → existence-gated canonical base.
    const expected = join(home, ".config", "metafactory", "cortex", "meta-factory");
    expect(s.hostOverrides).toEqual({ cortex: { configRoot: expected } });
    expect(s.cortexConfigEnv).toEqual({ CORTEX_CONFIG: expected });
    // credsRoot must NOT appear — creds stay at ~/.config/nats/creds.
    expect(
      (s.hostOverrides?.cortex as Record<string, unknown>).credsRoot,
    ).toBeUndefined();
  });

  test("propagates the resolution error for an invalid stack name", () => {
    expect(() => buildCortexInstallSteering({ stack: "../evil", home })).toThrow(
      /stack name/i,
    );
  });
});
