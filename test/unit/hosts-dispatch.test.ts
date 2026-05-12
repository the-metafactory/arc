import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hostPathFor, requireHostDir } from "../../src/lib/hosts/dispatch.js";
import { createArcPaths, getDefaultHost } from "../../src/lib/paths.js";
import { createArtifactSymlinks } from "../../src/lib/artifact-installer.js";
import type { ArcManifest, HostAdapter } from "../../src/types.js";

describe("hostPathFor", () => {
  const host = getDefaultHost({ root: "/tmp/test/.claude" });

  test("maps skill → skillsDir", () => {
    expect(hostPathFor(host, "skill")).toBe("/tmp/test/.claude/skills");
  });

  test("maps system (legacy alias) → skillsDir", () => {
    expect(hostPathFor(host, "system")).toBe("/tmp/test/.claude/skills");
  });

  test("maps agent → agentsDir", () => {
    expect(hostPathFor(host, "agent")).toBe("/tmp/test/.claude/agents");
  });

  test("maps prompt → promptsDir", () => {
    expect(hostPathFor(host, "prompt")).toBe("/tmp/test/.claude/commands");
  });

  test("maps tool → binDir", () => {
    expect(hostPathFor(host, "tool")).toBe("/tmp/test/.claude/bin");
  });

  test("returns null for component (no per-type primary layout)", () => {
    expect(hostPathFor(host, "component")).toBeNull();
  });

  test("returns null for rules (writes into consumer repo, not host)", () => {
    expect(hostPathFor(host, "rules")).toBeNull();
  });

  test("returns null for library (meta type; contained artifacts route individually)", () => {
    expect(hostPathFor(host, "library")).toBeNull();
  });

  test("returns null for pipeline (arc state, not host)", () => {
    expect(hostPathFor(host, "pipeline")).toBeNull();
  });

  test("returns null for action (arc state, not host)", () => {
    expect(hostPathFor(host, "action")).toBeNull();
  });
});

// Stub adapter with empty host paths — used to exercise the `if (!dir)`
// guard / requireHostDir() throws when a future host adapter doesn't expose
// a directory for a given artifact type. With only the Claude-Code adapter
// shipping today, this is the only way to fire those paths.
function makeEmptyPathHost(): HostAdapter {
  return {
    id: "claude-code",
    detect: () => false,
    paths: {
      root: "",
      skillsDir: "",
      agentsDir: "",
      promptsDir: "",
      binDir: "",
      settingsPath: "",
    },
    supports: () => false,
  };
}

describe("createArtifactSymlinks null-guard throws", () => {
  test("hostPathFor returns falsy for skill when host paths are empty", () => {
    // The artifact-installer guard is `if (!dir)`, which catches both null
    // and empty string — the runtime safety net works for both shapes.
    const stub = makeEmptyPathHost();
    expect(Boolean(hostPathFor(stub, "skill"))).toBe(false);
  });

  test("createArtifactSymlinks throws when the host has no agent directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "arc-guard-test-"));
    try {
      const arc = createArcPaths({
        configRoot: join(tmp, ".config", "metafactory"),
      });
      const stub = makeEmptyPathHost();
      const manifest: ArcManifest = {
        name: "stub-agent",
        version: "1.0.0",
        type: "agent",
      };

      await expect(
        createArtifactSymlinks({
          type: "agent",
          manifest,
          arc,
          host: stub,
          installDir: tmp,
          quiet: true,
        }),
      ).rejects.toThrow(/does not support agent artifacts/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("skills without CLI entries install cleanly even when host has no binDir", async () => {
    // Carryover from Holly's review on #119: the binDir guard used to fire
    // unconditionally for every skill install. A skill with zero CLI
    // entries doesn't need binDir, so a future adapter that supports
    // skills but exposes no binDir should still install pure-content
    // skills successfully.
    const tmp = mkdtempSync(join(tmpdir(), "arc-skill-nocli-"));
    try {
      const arc = createArcPaths({
        configRoot: join(tmp, ".config", "metafactory"),
      });
      const claudeRoot = join(tmp, ".claude");
      // Host that exposes skillsDir but no binDir.
      const skillsOnlyHost: HostAdapter = {
        id: "claude-code",
        detect: () => true,
        paths: {
          root: claudeRoot,
          skillsDir: join(claudeRoot, "skills"),
          agentsDir: "",
          promptsDir: "",
          binDir: "",
          settingsPath: "",
        },
        supports: () => true,
      };
      const manifest: ArcManifest = {
        name: "pure-content-skill",
        version: "1.0.0",
        type: "skill",
      };

      const result = await createArtifactSymlinks({
        type: "skill",
        manifest,
        arc,
        host: skillsOnlyHost,
        installDir: tmp,
        quiet: true,
      });

      expect(result.record.symlinks.length).toBe(1);
      expect(result.record.shims.names.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("requireHostDir", () => {
  test("returns the directory for supported types (passthrough of hostPathFor)", () => {
    const host = getDefaultHost({ root: "/tmp/test/.claude" });
    expect(requireHostDir(host, "skill")).toBe("/tmp/test/.claude/skills");
    expect(requireHostDir(host, "agent")).toBe("/tmp/test/.claude/agents");
    expect(requireHostDir(host, "prompt")).toBe("/tmp/test/.claude/commands");
    expect(requireHostDir(host, "tool")).toBe("/tmp/test/.claude/bin");
  });

  test("throws with default message when hostPathFor returns null", () => {
    const host = getDefaultHost({ root: "/tmp/test/.claude" });
    expect(() => requireHostDir(host, "rules")).toThrow(
      /Host claude-code does not support rules artifacts/,
    );
  });

  test("accepts a custom description for context-specific guards", () => {
    const host = getDefaultHost({ root: "/tmp/test/.claude" });
    expect(() =>
      requireHostDir(host, "library", "expose a registry for library artifacts"),
    ).toThrow(
      /Host claude-code does not expose a registry for library artifacts/,
    );
  });

  test("throws with host id baked into the error message", () => {
    const stubHost = makeEmptyPathHost();
    expect(() => requireHostDir(stubHost, "skill")).toThrow(/^Host claude-code/);
  });
});
