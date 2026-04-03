import { describe, test, expect } from "bun:test";
import { createPaths } from "../../src/lib/paths.js";
import { homedir } from "os";
import { join } from "path";

describe("createPaths", () => {
  test("returns default paths based on homedir", () => {
    const paths = createPaths();
    const home = homedir();

    expect(paths.claudeRoot).toBe(join(home, ".claude"));
    expect(paths.skillsDir).toBe(join(home, ".claude", "skills"));
    expect(paths.binDir).toBe(join(home, ".claude", "bin"));
    expect(paths.configRoot).toBe(join(home, ".config", "metafactory"));
    expect(paths.dbPath).toBe(join(home, ".config", "metafactory", "packages.db"));
  });

  test("accepts overrides for test isolation", () => {
    const paths = createPaths({
      claudeRoot: "/tmp/test/.claude",
      configRoot: "/tmp/test/.config/metafactory",
    });

    expect(paths.claudeRoot).toBe("/tmp/test/.claude");
    expect(paths.skillsDir).toBe("/tmp/test/.claude/skills");
    expect(paths.configRoot).toBe("/tmp/test/.config/metafactory");
    expect(paths.dbPath).toBe("/tmp/test/.config/metafactory/packages.db");
  });

  test("ARC_CONFIG_ROOT env var overrides default configRoot", () => {
    const original = process.env.ARC_CONFIG_ROOT;
    try {
      process.env.ARC_CONFIG_ROOT = "/custom/arc-config";
      const paths = createPaths();
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
      const paths = createPaths({ configRoot: "/explicit/override" });
      expect(paths.configRoot).toBe("/explicit/override");
    } finally {
      if (original === undefined) delete process.env.ARC_CONFIG_ROOT;
      else process.env.ARC_CONFIG_ROOT = original;
    }
  });

  test("specific overrides take precedence over derived paths", () => {
    const paths = createPaths({
      claudeRoot: "/tmp/test/.claude",
      skillsDir: "/custom/skills",
    });

    expect(paths.claudeRoot).toBe("/tmp/test/.claude");
    expect(paths.skillsDir).toBe("/custom/skills");
    // binDir should derive from claudeRoot
    expect(paths.binDir).toBe("/tmp/test/.claude/bin");
  });
});
