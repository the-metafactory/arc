import { describe, test, expect } from "bun:test";
import { join } from "path";
import { resolveProvidesTarget } from "../../src/lib/provides-target.js";

describe("resolveProvidesTarget — {bin} token (#287)", () => {
  const home = "/scratch/home";

  test("{bin} resolves to the xdg binDir (~/.local/bin fallback when not on PATH)", () => {
    const out = resolveProvidesTarget("{bin}/mytool", {
      home,
      env: { PATH: "" },
      platform: "linux",
    });
    expect(out).toBe(join(home, ".local", "bin", "mytool"));
  });

  test("{bin} prefers ~/bin when it is already on $PATH", () => {
    const out = resolveProvidesTarget("{bin}/mytool", {
      home,
      env: { PATH: `${home}/bin` },
      platform: "linux",
    });
    expect(out).toBe(join(home, "bin", "mytool"));
  });

  test("{bin} honors an XDG-styled ~/.local/bin already on $PATH", () => {
    const out = resolveProvidesTarget("{bin}/mytool", {
      home,
      env: { PATH: `${home}/.local/bin` },
      platform: "linux",
    });
    expect(out).toBe(join(home, ".local", "bin", "mytool"));
  });

  test("leading ~ still expands (backwards-compatible with pre-#287 targets)", () => {
    const out = resolveProvidesTarget("~/.claude/agents/foo.md", { home });
    expect(out).toBe(join(home, ".claude", "agents", "foo.md"));
  });

  test("a plain absolute target is returned unchanged", () => {
    const out = resolveProvidesTarget("/etc/foo/bar", { home });
    expect(out).toBe("/etc/foo/bar");
  });

  test("{data}/{cache}/{state}/{config} resolve to arc's XDG suite-app roots", () => {
    const seam = { home, env: {}, platform: "linux" };
    expect(resolveProvidesTarget("{data}/x", seam)).toBe(
      join(home, ".local", "share", "metafactory", "arc", "x"),
    );
    expect(resolveProvidesTarget("{cache}/x", seam)).toBe(
      join(home, ".cache", "metafactory", "arc", "x"),
    );
    expect(resolveProvidesTarget("{state}/x", seam)).toBe(
      join(home, ".local", "state", "metafactory", "arc", "x"),
    );
    expect(resolveProvidesTarget("{config}/x", seam)).toBe(
      join(home, ".config", "metafactory", "arc", "x"),
    );
  });

  test("{data} honors $XDG_DATA_HOME", () => {
    const out = resolveProvidesTarget("{data}/x", {
      home,
      env: { XDG_DATA_HOME: "/xdg/data" },
      platform: "linux",
    });
    expect(out).toBe(join("/xdg/data", "metafactory", "arc", "x"));
  });
});

describe("resolveProvidesTarget — {cortex-config} token (G-18, cortex#1867)", () => {
  const home = "/scratch/home";

  test("{cortex-config} resolves to the existence-gated cortex config dir (canonical on a fresh box)", () => {
    // Scratch home, empty env, no trees on disk → canonical metafactory/cortex.
    const out = resolveProvidesTarget("{cortex-config}/agents.d/echo.yaml", {
      home,
      env: {},
    });
    expect(out).toBe(
      join(home, ".config", "metafactory", "cortex", "agents.d", "echo.yaml"),
    );
  });

  test("{cortex-config} honors $CORTEX_CONFIG_DIR verbatim (self-contained root)", () => {
    const out = resolveProvidesTarget("{cortex-config}/agents.d/echo.yaml", {
      home,
      env: { CORTEX_CONFIG_DIR: "/srv/cortex-cfg" },
    });
    expect(out).toBe(join("/srv/cortex-cfg", "agents.d", "echo.yaml"));
  });

  test("{cortex-config} is DISTINCT from arc's own {config}", () => {
    // {config} → arc's suite-app root (metafactory/arc); {cortex-config} → the
    // LIVE cortex config dir (metafactory/cortex). They must never collide.
    const seam = { home, env: {} };
    const arcConfig = resolveProvidesTarget("{config}/x", seam);
    const cortexConfig = resolveProvidesTarget("{cortex-config}/x", seam);
    expect(arcConfig).toBe(join(home, ".config", "metafactory", "arc", "x"));
    expect(cortexConfig).toBe(join(home, ".config", "metafactory", "cortex", "x"));
    expect(arcConfig).not.toBe(cortexConfig);
  });

  test("{cortex-config} does NOT disturb {config} in the same target", () => {
    const out = resolveProvidesTarget("{cortex-config}/a::{config}/b", {
      home,
      env: {},
    });
    expect(out).toBe(
      `${join(home, ".config", "metafactory", "cortex", "a")}::${join(
        home,
        ".config",
        "metafactory",
        "arc",
        "b",
      )}`,
    );
  });
});
