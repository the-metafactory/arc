import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { cortexPaths, createCortexHost } from "../../src/lib/hosts/cortex.js";
import { hostPathFor, requireHostDir } from "../../src/lib/hosts/dispatch.js";
import type { ArtifactType } from "../../src/types.js";

describe("cortexPaths", () => {
  test("DEFAULT config root is existence-gated: canonical metafactory/cortex on a fresh box", () => {
    // Hermetic: a scratch home with NO cortex trees on disk + empty env → the
    // existence-gated DEFAULT resolves to the canonical `metafactory/cortex`
    // (matching a migrated/fresh cortex). Creds stay NATS-conventional.
    const tmp = mkdtempSync(join(tmpdir(), "arc-cortex-default-"));
    try {
      const paths = cortexPaths({ seam: { home: tmp, env: {} } });
      expect(paths.root).toBe(join(tmp, ".config", "metafactory", "cortex"));
      expect(paths.settingsPath).toBe(
        join(tmp, ".config", "metafactory", "cortex", "cortex.yaml"),
      );
      expect(paths.agentsDir).toBe(
        join(tmp, ".config", "metafactory", "cortex", "agents.d"),
      );
      expect(paths.personasDir).toBe(
        join(tmp, ".config", "metafactory", "cortex", "personas"),
      );
      expect(paths.credsDir).toBe(join(tmp, ".config", "nats", "creds"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("DEFAULT config root is existence-gated: legacy ~/.config/cortex wins when present (byte-identical pre-cutover)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-cortex-legacy-"));
    try {
      mkdirSync(join(tmp, ".config", "cortex"), { recursive: true });
      const paths = cortexPaths({ seam: { home: tmp, env: {} } });
      expect(paths.root).toBe(join(tmp, ".config", "cortex"));
      expect(paths.agentsDir).toBe(join(tmp, ".config", "cortex", "agents.d"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("DEFAULT config root honors $CORTEX_CONFIG_DIR verbatim (self-contained root)", () => {
    const paths = cortexPaths({
      seam: { home: "/scratch/home", env: { CORTEX_CONFIG_DIR: "/srv/cortex-cfg" } },
    });
    expect(paths.root).toBe("/srv/cortex-cfg");
    expect(paths.agentsDir).toBe(join("/srv/cortex-cfg", "agents.d"));
  });

  test("honors configRoot override", () => {
    const paths = cortexPaths({ configRoot: "/tmp/test/.config/cortex" });
    expect(paths.root).toBe("/tmp/test/.config/cortex");
    expect(paths.settingsPath).toBe("/tmp/test/.config/cortex/cortex.yaml");
    expect(paths.agentsDir).toBe("/tmp/test/.config/cortex/agents.d");
    expect(paths.personasDir).toBe("/tmp/test/.config/cortex/personas");
    // credsDir is independent of configRoot — defaults to ~/.config/nats/creds
    expect(paths.credsDir).toBe(join(homedir(), ".config", "nats", "creds"));
  });

  test("honors credsRoot override independently of configRoot", () => {
    const paths = cortexPaths({
      configRoot: "/tmp/cortex",
      credsRoot: "/tmp/nats/creds",
    });
    expect(paths.credsDir).toBe("/tmp/nats/creds");
    expect(paths.agentsDir).toBe("/tmp/cortex/agents.d");
  });

  test("leaves non-cortex artifact paths empty (cortex is agent-only)", () => {
    const paths = cortexPaths({ configRoot: "/tmp/x" });
    // Cortex doesn't host skills/prompts/tools — keep these empty so the
    // `if (!dir)` guards in dispatch / artifact-installer fire correctly if a
    // caller forgets to consult `supports()` first.
    expect(paths.skillsDir).toBe("");
    expect(paths.promptsDir).toBe("");
    expect(paths.binDir).toBe("");
  });
});

describe("createCortexHost", () => {
  test("returns a HostAdapter with id 'cortex'", () => {
    const host = createCortexHost({ configRoot: "/tmp/x" });
    expect(host.id).toBe("cortex");
  });

  test("supports agent and only agent", () => {
    const host = createCortexHost({ configRoot: "/tmp/x" });
    const types: ArtifactType[] = [
      "skill",
      "agent",
      "prompt",
      "tool",
      "component",
      "pipeline",
      "rules",
      "library",
      "action",
    ];
    for (const type of types) {
      expect(host.supports(type)).toBe(type === "agent");
    }
  });

  test("detect() true when cortex.yaml exists at settings path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-cortex-detect-"));
    try {
      const configRoot = join(tmp, ".config", "cortex");
      mkdirSync(configRoot, { recursive: true });
      writeFileSync(join(configRoot, "cortex.yaml"), "version: 1\n");
      const host = createCortexHost({ configRoot });
      expect(host.detect()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("detect() false when no cortex.yaml at settings path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-cortex-nodetect-"));
    try {
      const host = createCortexHost({
        configRoot: join(tmp, ".config", "cortex"),
      });
      expect(host.detect()).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("detect() ignores cortex binary on PATH — config file is the sole signal", () => {
    // Echo arc#121: an `execSync("command -v cortex")` PATH probe is
    // POSIX-only (Windows has no `/bin/sh`) and an order of magnitude heavier
    // than the cross-platform `existsSync` claude-code uses. Detection is
    // intentionally config-file-only; this test pins that contract so a
    // future re-introduction of a binary probe has to update the assertion
    // explicitly.
    const tmp = mkdtempSync(join(tmpdir(), "arc-cortex-no-bin-probe-"));
    try {
      const host = createCortexHost({
        configRoot: join(tmp, ".config", "cortex"),
      });
      // Even if `cortex` happens to be on the dev host's PATH, detect() must
      // stay false because the config file is absent.
      expect(host.detect()).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exposes cortex-only path extensions on host.paths", () => {
    const host = createCortexHost({
      configRoot: "/tmp/x",
      credsRoot: "/tmp/y",
    });
    // Type narrows because createCortexHost returns HostAdapter & { paths: CortexHostPaths }
    expect(host.paths.personasDir).toBe("/tmp/x/personas");
    expect(host.paths.credsDir).toBe("/tmp/y");
  });
});

describe("hostPathFor integration with cortex host", () => {
  test("maps agent → agentsDir", () => {
    const host = createCortexHost({ configRoot: "/tmp/x" });
    expect(hostPathFor(host, "agent")).toBe("/tmp/x/agents.d");
  });

  test("returns null for non-host-directory types (component/rules/library)", () => {
    const host = createCortexHost({ configRoot: "/tmp/x" });
    expect(hostPathFor(host, "component")).toBeNull();
    expect(hostPathFor(host, "rules")).toBeNull();
    expect(hostPathFor(host, "library")).toBeNull();
    expect(hostPathFor(host, "pipeline")).toBeNull();
    expect(hostPathFor(host, "action")).toBeNull();
  });

  test("returns empty string for types cortex doesn't host (skill/prompt/tool)", () => {
    // Cortex's `supports()` is the truthful gate — these types return false
    // there. `hostPathFor` still hands back the host's declared directory
    // (empty string), and the `if (!dir)` guard in artifact-installer treats
    // it as falsy, matching the contract from the dispatch test.
    const host = createCortexHost({ configRoot: "/tmp/x" });
    expect(hostPathFor(host, "skill")).toBe("");
    expect(hostPathFor(host, "prompt")).toBe("");
    expect(hostPathFor(host, "tool")).toBe("");
  });

  test("requireHostDir throws for unsupported artifact types", () => {
    const host = createCortexHost({ configRoot: "/tmp/x" });
    // skill -> hostPathFor returns "" (falsy) -> requireHostDir throws
    expect(() => requireHostDir(host, "skill")).toThrow(
      /Host cortex does not/,
    );
    // agent -> returns agentsDir, no throw
    expect(requireHostDir(host, "agent")).toBe("/tmp/x/agents.d");
  });
});
