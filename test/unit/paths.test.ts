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
    expect(paths.configRoot).toBe(join(home, ".config", "arc"));
    expect(paths.dbPath).toBe(join(home, ".config", "arc", "packages.db"));
  });

  test("accepts overrides for test isolation", () => {
    const paths = createPaths({
      claudeRoot: "/tmp/test/.claude",
      configRoot: "/tmp/test/.config/pai",
    });

    expect(paths.claudeRoot).toBe("/tmp/test/.claude");
    expect(paths.skillsDir).toBe("/tmp/test/.claude/skills");
    expect(paths.configRoot).toBe("/tmp/test/.config/pai");
    expect(paths.dbPath).toBe("/tmp/test/.config/pai/packages.db");
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
