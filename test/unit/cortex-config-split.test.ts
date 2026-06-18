import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import {
  detectCortexLayout,
  resolveCortexConfigRoot,
  buildCortexInstallSteering,
  CORTEX_LAYOUT_MARKER,
} from "../../src/lib/hosts/cortex-config-split.js";

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

  test("--stack <name> → ~/.config/cortex/<name>", () => {
    const r = resolveCortexConfigRoot({ stack: "meta-factory", home });
    expect(r.configRoot).toBe(join(home, ".config", "cortex", "meta-factory"));
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
    const r = resolveCortexConfigRoot({ stack: "work", home: "/custom/home" });
    expect(r.configRoot).toBe("/custom/home/.config/cortex/work");
  });

  test("rejects --config-dir together with --stack (ambiguous)", () => {
    expect(() =>
      resolveCortexConfigRoot({ configDir: "/x", stack: "y", home }),
    ).toThrow(/both --config-dir and --stack/i);
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
    const r = resolveCortexConfigRoot({ stack: "s" });
    expect(r.configRoot).toBe(join(homedir(), ".config", "cortex", "s"));
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
    const s = buildCortexInstallSteering({ stack: "meta-factory", home });
    const expected = join(home, ".config", "cortex", "meta-factory");
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
