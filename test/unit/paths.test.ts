import { describe, test, expect } from "bun:test";
import {
  createArcPaths,
  getDefaultHost,
  migrateConfigIfNeeded,
  resolveDefaultShimDir,
  isDirOnPath,
} from "../../src/lib/paths.js";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

describe("createArcPaths env-var handling", () => {
  test("ARC_CONFIG_ROOT env var overrides default configRoot", () => {
    const original = process.env.ARC_CONFIG_ROOT;
    try {
      process.env.ARC_CONFIG_ROOT = "/custom/arc-config";
      const paths = createArcPaths();
      expect(paths.configRoot).toBe("/custom/arc-config");
      expect(paths.dbPath).toBe("/custom/arc-config/packages.db");
    } finally {
      if (original === undefined) delete process.env.ARC_CONFIG_ROOT;
      else process.env.ARC_CONFIG_ROOT = original;
    }
  });

  test("explicit override takes precedence over ARC_CONFIG_ROOT env var", () => {
    const original = process.env.ARC_CONFIG_ROOT;
    try {
      process.env.ARC_CONFIG_ROOT = "/env/override";
      const paths = createArcPaths({ configRoot: "/explicit/override" });
      expect(paths.configRoot).toBe("/explicit/override");
    } finally {
      if (original === undefined) delete process.env.ARC_CONFIG_ROOT;
      else process.env.ARC_CONFIG_ROOT = original;
    }
  });
});

describe("createArcPaths", () => {
  test("returns host-independent state paths from config root", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const configRoot = join(mkdtempSync(join(tmpdir(), "arc-paths-config-")), "metafactory");
      const paths = createArcPaths({ configRoot });
      const home = homedir();

      expect(paths.configRoot).toBe(configRoot);
      expect(paths.dbPath).toBe(join(configRoot, "packages.db"));
      expect(paths.reposDir).toBe(join(configRoot, "pkg", "repos"));
      expect(paths.cachePath).toBe(join(configRoot, "pkg", "cache"));
      expect(paths.shimDir).toBe(join(home, ".local", "bin"));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test("does not expose host-specific paths", () => {
    const paths = createArcPaths();
    // ArcPaths must not carry host fields — those live on HostAdapter.paths
    expect(paths).not.toHaveProperty("skillsDir");
    expect(paths).not.toHaveProperty("agentsDir");
    expect(paths).not.toHaveProperty("promptsDir");
    expect(paths).not.toHaveProperty("binDir");
    expect(paths).not.toHaveProperty("settingsPath");
    expect(paths).not.toHaveProperty("claudeRoot");
  });

  test("accepts configRoot override", () => {
    const paths = createArcPaths({ configRoot: "/tmp/test/.config/mf" });
    expect(paths.configRoot).toBe("/tmp/test/.config/mf");
    expect(paths.dbPath).toBe("/tmp/test/.config/mf/packages.db");
    expect(paths.reposDir).toBe("/tmp/test/.config/mf/pkg/repos");
  });

  test("specific overrides take precedence over derived paths", () => {
    const paths = createArcPaths({
      configRoot: "/tmp/test/.config/mf",
      dbPath: "/custom/packages.db",
    });
    expect(paths.dbPath).toBe("/custom/packages.db");
    // reposDir still derived from configRoot
    expect(paths.reposDir).toBe("/tmp/test/.config/mf/pkg/repos");
  });

  test("uses remembered bin-dir from config.yaml", () => {
    const base = mkdtempSync(join(tmpdir(), "arc-bin-config-"));
    const configRoot = join(base, "metafactory");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "config.yaml"), "bin_dir: ~/.arc/bin\n");

    const paths = createArcPaths({ configRoot });

    expect(paths.shimDir).toBe(join(homedir(), ".arc", "bin"));
  });
});

describe("resolveDefaultShimDir", () => {
  test("prefers ~/.local/bin when it is already on PATH", () => {
    const home = "/Users/tester";
    const dir = resolveDefaultShimDir({
      home,
      pathEnv: `${home}/bin:${home}/.local/bin:/usr/bin`,
    });

    expect(dir).toBe(`${home}/.local/bin`);
  });

  test("matches PATH entries with trailing slashes", () => {
    const home = "/Users/tester";
    const dir = resolveDefaultShimDir({
      home,
      pathEnv: `${home}/.local/bin/:/usr/bin`,
    });

    expect(dir).toBe(`${home}/.local/bin`);
  });

  test("falls back to ~/.local/bin instead of creating ~/bin", () => {
    const home = "/Users/tester";
    const dir = resolveDefaultShimDir({
      home,
      pathEnv: "/usr/bin:/bin",
    });

    expect(dir).toBe(`${home}/.local/bin`);
  });

  test("honors a remembered bin directory", () => {
    const home = "/Users/tester";
    const dir = resolveDefaultShimDir({
      home,
      pathEnv: "/usr/bin:/bin",
      configuredBinDir: "~/.arc/bin",
    });

    expect(dir).toBe(`${home}/.arc/bin`);
  });
});

/**
 * isDirOnPath splits a PATH-style string on the platform delimiter. The old
 * hard-coded `:` split mangled Windows PATHs — `;`-delimited, with a `:` inside
 * every `C:\...` drive letter — so `arc install` wrongly reported the shim dir
 * "not on PATH". These literal-string cases prove the win32 behavior on any host.
 */
describe("isDirOnPath", () => {
  test("win32: finds the dir on a ';'-delimited PATH despite drive-letter colons", () => {
    expect(
      isDirOnPath(
        "C:\\Users\\k\\.local\\bin",
        "C:\\Windows;C:\\Users\\k\\.local\\bin;C:\\Program Files\\bin",
        ";",
      ),
    ).toBe(true);
  });

  test("win32: a ':' split mangles drive letters and misses the dir (the bug)", () => {
    expect(
      isDirOnPath(
        "C:\\Users\\k\\.local\\bin",
        "C:\\Windows;C:\\Users\\k\\.local\\bin",
        ":",
      ),
    ).toBe(false);
  });

  test("win32: returns false when the dir is genuinely absent", () => {
    expect(
      isDirOnPath("C:\\Users\\k\\.local\\bin", "C:\\Windows;C:\\Other", ";"),
    ).toBe(false);
  });

  test("posix: finds the dir on a ':'-delimited PATH", () => {
    expect(
      isDirOnPath("/Users/k/.local/bin", "/usr/bin:/Users/k/.local/bin:/bin", ":"),
    ).toBe(true);
  });

  test("posix: matches an entry with a trailing slash", () => {
    expect(
      isDirOnPath("/Users/k/.local/bin", "/Users/k/.local/bin/:/usr/bin", ":"),
    ).toBe(true);
  });

  test("posix: returns false when the dir is absent", () => {
    expect(isDirOnPath("/opt/bin", "/usr/bin:/bin", ":")).toBe(false);
  });
});

describe("getDefaultHost", () => {
  test("returns a Claude-Code host adapter", () => {
    const host = getDefaultHost();
    expect(host.id).toBe("claude-code");
    expect(host.paths.root).toBe(join(homedir(), ".claude"));
    expect(host.paths.skillsDir).toBe(join(homedir(), ".claude", "skills"));
    expect(host.paths.agentsDir).toBe(join(homedir(), ".claude", "agents"));
    expect(host.paths.promptsDir).toBe(join(homedir(), ".claude", "commands"));
    expect(host.paths.binDir).toBe(join(homedir(), ".claude", "bin"));
    expect(host.paths.settingsPath).toBe(join(homedir(), ".claude", "settings.json"));
  });

  test("accepts a custom root for test isolation", () => {
    const host = getDefaultHost({ root: "/tmp/test/.claude" });
    expect(host.paths.root).toBe("/tmp/test/.claude");
    expect(host.paths.skillsDir).toBe("/tmp/test/.claude/skills");
  });

  test("supports all current artifact types for skills/agents/prompts/tools/components", () => {
    const host = getDefaultHost();
    expect(host.supports("skill")).toBe(true);
    expect(host.supports("agent")).toBe(true);
    expect(host.supports("prompt")).toBe(true);
    expect(host.supports("tool")).toBe(true);
    expect(host.supports("component")).toBe(true);
    expect(host.supports("rules")).toBe(true);
    expect(host.supports("library")).toBe(true);
  });

  test("does not claim support for arc-state artifact types", () => {
    const host = getDefaultHost();
    // pipelines and actions live in arc state, not in any host directory
    expect(host.supports("pipeline")).toBe(false);
    expect(host.supports("action")).toBe(false);
  });

  test("detect() returns false when the host root does not exist", () => {
    const host = getDefaultHost({ root: "/tmp/definitely-does-not-exist-xyz" });
    expect(host.detect()).toBe(false);
  });

  test("detect() returns true when the host root exists", () => {
    // Positive path matters more than the negative one — a false positive in
    // Phase 2 would silently activate the wrong adapter.
    const root = mkdtempSync(join(tmpdir(), "arc-host-detect-"));
    try {
      const host = getDefaultHost({ root });
      expect(host.detect()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("migrateConfigIfNeeded", () => {
  function createTempBase(): string {
    const base = mkdtempSync(join(tmpdir(), "arc-migration-test-"));
    return base;
  }

  function cleanupTemp(base: string): void {
    rmSync(base, { recursive: true, force: true });
  }

  test("migrates old config directory to new location", () => {
    const base = createTempBase();
    try {
      const oldPath = join(base, "old-config");
      const newPath = join(base, "new-config");

      // Create old directory with some content
      mkdirSync(join(oldPath, "pkg", "repos"), { recursive: true });
      writeFileSync(join(oldPath, "packages.db"), "mock-db-content");
      writeFileSync(join(oldPath, "sources.yaml"), "sources: []");

      // Run migration
      migrateConfigIfNeeded(oldPath, newPath);

      // Old path should be gone, new path should exist with contents
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(join(newPath, "packages.db"), "utf-8")).toBe("mock-db-content");
      expect(readFileSync(join(newPath, "sources.yaml"), "utf-8")).toBe("sources: []");
      expect(existsSync(join(newPath, "pkg", "repos"))).toBe(true);
    } finally {
      cleanupTemp(base);
    }
  });

  test("no-op when old path does not exist", () => {
    const base = createTempBase();
    try {
      const oldPath = join(base, "nonexistent");
      const newPath = join(base, "new-config");

      migrateConfigIfNeeded(oldPath, newPath);

      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(newPath)).toBe(false);
    } finally {
      cleanupTemp(base);
    }
  });

  test("no-op when both old and new paths exist", () => {
    const base = createTempBase();
    try {
      const oldPath = join(base, "old-config");
      const newPath = join(base, "new-config");

      // Create both directories with different content
      mkdirSync(oldPath, { recursive: true });
      writeFileSync(join(oldPath, "packages.db"), "old-content");
      mkdirSync(newPath, { recursive: true });
      writeFileSync(join(newPath, "packages.db"), "new-content");

      migrateConfigIfNeeded(oldPath, newPath);

      // Both should still exist, new content should be unchanged
      expect(existsSync(oldPath)).toBe(true);
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(join(newPath, "packages.db"), "utf-8")).toBe("new-content");
    } finally {
      cleanupTemp(base);
    }
  });

  test("no-op when new path already exists (even if old does not)", () => {
    const base = createTempBase();
    try {
      const oldPath = join(base, "nonexistent");
      const newPath = join(base, "new-config");

      mkdirSync(newPath, { recursive: true });
      writeFileSync(join(newPath, "packages.db"), "existing-content");

      migrateConfigIfNeeded(oldPath, newPath);

      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(join(newPath, "packages.db"), "utf-8")).toBe("existing-content");
    } finally {
      cleanupTemp(base);
    }
  });

  test("handles permission errors gracefully (logs warning, does not throw)", () => {
    const base = createTempBase();
    try {
      // Passing a path that will fail on rename (old exists, new parent doesn't)
      const oldPath = join(base, "old-config");
      const newPath = join(base, "nonexistent-parent", "deeply", "nested", "new-config");

      mkdirSync(oldPath, { recursive: true });

      // Should not throw - just log a warning
      expect(() => migrateConfigIfNeeded(oldPath, newPath)).not.toThrow();

      // Old path should still exist since migration failed
      expect(existsSync(oldPath)).toBe(true);
    } finally {
      cleanupTemp(base);
    }
  });
});
