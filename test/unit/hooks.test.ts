import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { writeFile } from "fs/promises";
import {
  registerHooks,
  removeHooks,
  listPackageHooks,
  resolveHooksFromManifest,
  hasHooks,
  findMissingHookFiles,
} from "../../src/lib/hooks.js";

let tmpDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pai-hooks-test-"));
  settingsPath = join(tmpDir, "settings.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("registerHooks", () => {
  test("creates settings.json with hooks when file does not exist", async () => {
    await registerHooks(
      "Grove",
      [{ event: "PostToolUse", command: "${PAI_DIR}/hooks/EventLogger.hook.ts" }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeArrayOfSize(1);
    expect(settings.hooks.PostToolUse[0]._pai_pkg).toBe("Grove");
    expect(settings.hooks.PostToolUse[0].hooks[0].type).toBe("command");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      "${PAI_DIR}/hooks/EventLogger.hook.ts",
    );
  });

  test("preserves existing settings when adding hooks", async () => {
    await Bun.write(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Read"] } }, null, 4),
    );

    await registerHooks(
      "Grove",
      [{ event: "Stop", command: "${PAI_DIR}/hooks/Stop.hook.ts" }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(settings.hooks.Stop).toBeArrayOfSize(1);
  });

  test("preserves existing hooks from other packages", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _pai_pkg: "OtherPackage",
            hooks: [{ type: "command", command: "/other/hook.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await registerHooks(
      "Grove",
      [{ event: "PostToolUse", command: "${PAI_DIR}/hooks/EventLogger.hook.ts" }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PostToolUse).toBeArrayOfSize(2);
    expect(settings.hooks.PostToolUse[0]._pai_pkg).toBe("OtherPackage");
    expect(settings.hooks.PostToolUse[1]._pai_pkg).toBe("Grove");
  });

  test("registers multiple hooks across different events", async () => {
    await registerHooks(
      "Grove",
      [
        { event: "PostToolUse", command: "${PAI_DIR}/hooks/EventLogger.hook.ts" },
        { event: "Stop", command: "${PAI_DIR}/hooks/EventLogger.hook.ts" },
        { event: "PreToolUse", command: "${PAI_DIR}/hooks/BashGuard.hook.ts", matcher: "Bash" },
      ],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PostToolUse).toBeArrayOfSize(1);
    expect(settings.hooks.Stop).toBeArrayOfSize(1);
    expect(settings.hooks.PreToolUse).toBeArrayOfSize(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
  });

  test("deduplicates identical hook commands", async () => {
    await registerHooks(
      "Grove",
      [{ event: "PostToolUse", command: "${PAI_DIR}/hooks/EventLogger.hook.ts" }],
      settingsPath,
    );

    // Register same hook again
    await registerHooks(
      "Grove",
      [{ event: "PostToolUse", command: "${PAI_DIR}/hooks/EventLogger.hook.ts" }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PostToolUse).toBeArrayOfSize(1);
  });

  test("includes matcher field for PreToolUse hooks", async () => {
    await registerHooks(
      "Grove",
      [{ event: "PreToolUse", command: "${PAI_DIR}/hooks/BashGuard.hook.ts", matcher: "Bash" }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.hooks.PreToolUse[0]._pai_pkg).toBe("Grove");
  });

  test("formats JSON with 4-space indentation", async () => {
    await registerHooks(
      "Grove",
      [{ event: "PostToolUse", command: "/hooks/test.ts" }],
      settingsPath,
    );

    const raw = await Bun.file(settingsPath).text();
    // Should contain 4-space indentation
    expect(raw).toContain("    ");
    // Should be parseable
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("removeHooks", () => {
  test("removes all hooks for a specific package", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _pai_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/hook.ts" }],
          },
          {
            _pai_pkg: "OtherPkg",
            hooks: [{ type: "command", command: "/other/hook.ts" }],
          },
        ],
        Stop: [
          {
            _pai_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/stop.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await removeHooks("Grove", settingsPath);

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PostToolUse).toBeArrayOfSize(1);
    expect(settings.hooks.PostToolUse[0]._pai_pkg).toBe("OtherPkg");
    // Stop array should be empty or removed
    expect(settings.hooks.Stop?.length ?? 0).toBe(0);
  });

  test("preserves non-hook settings when removing", async () => {
    const existing = {
      permissions: { allow: ["Read"] },
      hooks: {
        PostToolUse: [
          {
            _pai_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/hook.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await removeHooks("Grove", settingsPath);

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.permissions.allow).toEqual(["Read"]);
  });

  test("handles missing settings.json gracefully", async () => {
    // Should not throw
    await removeHooks("Grove", settingsPath);
  });

  test("handles settings.json without hooks section", async () => {
    await Bun.write(
      settingsPath,
      JSON.stringify({ permissions: {} }, null, 4),
    );

    // Should not throw
    await removeHooks("Grove", settingsPath);

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.permissions).toBeDefined();
  });

  test("cleans up empty event arrays after removal", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _pai_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/hook.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await removeHooks("Grove", settingsPath);

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    // Empty arrays should be cleaned up
    expect(settings.hooks.PostToolUse?.length ?? 0).toBe(0);
  });
});

describe("listPackageHooks", () => {
  test("returns hooks for a specific package", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _pai_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/hook.ts" }],
          },
          {
            _pai_pkg: "OtherPkg",
            hooks: [{ type: "command", command: "/other/hook.ts" }],
          },
        ],
        Stop: [
          {
            _pai_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/stop.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    const hooks = listPackageHooks("Grove", settingsPath);
    expect(hooks).toBeArrayOfSize(2);
    expect(hooks).toContainEqual({ event: "PostToolUse", command: "/grove/hook.ts" });
    expect(hooks).toContainEqual({ event: "Stop", command: "/grove/stop.ts" });
  });

  test("returns empty array when package has no hooks", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _pai_pkg: "OtherPkg",
            hooks: [{ type: "command", command: "/other/hook.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    const hooks = listPackageHooks("Grove", settingsPath);
    expect(hooks).toBeArrayOfSize(0);
  });

  test("returns empty array when settings.json does not exist", async () => {
    const hooks = listPackageHooks("Grove", settingsPath);
    expect(hooks).toBeArrayOfSize(0);
  });

  test("returns empty array when no hooks section exists", async () => {
    await Bun.write(
      settingsPath,
      JSON.stringify({ permissions: {} }, null, 4),
    );

    const hooks = listPackageHooks("Grove", settingsPath);
    expect(hooks).toBeArrayOfSize(0);
  });
});

describe("resolveHooksFromManifest", () => {
  test("returns null for undefined hooks", () => {
    const result = resolveHooksFromManifest(undefined, "/install/path", "TestPkg");
    expect(result).toBeNull();
  });

  test("passes through inline array format unchanged (no env vars)", () => {
    const inline = [
      { event: "PostToolUse", command: "/absolute/path/hook.ts" },
      { event: "Stop", command: "/absolute/path/stop.ts" },
    ];
    const result = resolveHooksFromManifest(inline, "/install/path", "TestPkg");
    expect(result).toEqual(inline);
  });

  test("resolves $PKG_DIR in inline array commands", () => {
    const inline = [
      { event: "PostToolUse", command: "bun $PKG_DIR/src/hooks/hook.ts" },
    ];
    const result = resolveHooksFromManifest(inline, "/opt/packages/mypkg", "MyPkg");
    expect(result).toEqual([
      { event: "PostToolUse", command: "bun /opt/packages/mypkg/src/hooks/hook.ts" },
    ]);
  });

  test("resolves $NAME_DIR env var to install path", () => {
    const inline = [
      { event: "SessionStart", command: "bun $MINER_DIR/src/hooks/EventLogger.hook.ts" },
    ];
    const result = resolveHooksFromManifest(inline, "/home/user/.config/metafactory/pkg/repos/miner", "Miner");
    expect(result).toEqual([
      { event: "SessionStart", command: "bun /home/user/.config/metafactory/pkg/repos/miner/src/hooks/EventLogger.hook.ts" },
    ]);
  });

  test("resolves ${PKG_DIR} brace syntax to install path", () => {
    const inline = [
      { event: "PostToolUse", command: "bun ${PKG_DIR}/src/hooks/hook.ts" },
    ];
    const result = resolveHooksFromManifest(inline, "/opt/packages/mypkg", "MyPkg");
    expect(result).toEqual([
      { event: "PostToolUse", command: "bun /opt/packages/mypkg/src/hooks/hook.ts" },
    ]);
  });

  test("resolves ${NAME_DIR} brace syntax to install path", () => {
    const inline = [
      { event: "SessionStart", command: "bun ${MINER_DIR}/src/hooks/MinerEventLogger.hook.ts" },
    ];
    const result = resolveHooksFromManifest(inline, "/home/user/.config/metafactory/pkg/repos/miner", "Miner");
    expect(result).toEqual([
      { event: "SessionStart", command: "bun /home/user/.config/metafactory/pkg/repos/miner/src/hooks/MinerEventLogger.hook.ts" },
    ]);
  });

  test("loads and flattens config-file JSON format", async () => {
    // Create a temporary hooks JSON file
    const hooksJson = {
      hooks: {
        SessionStart: [{ type: "command", command: "bun $MINER_DIR/src/hooks/Logger.ts" }],
        PostToolUse: [{ type: "command", command: "bun $MINER_DIR/src/hooks/Logger.ts" }],
        Stop: [{ type: "command", command: "bun $MINER_DIR/src/hooks/Logger.ts" }],
      },
    };
    const configDir = join(tmpDir, "mock-repo");
    const configPath = join(configDir, "src", "hooks", "hooks.json");
    await Bun.write(configPath, JSON.stringify(hooksJson));

    const result = resolveHooksFromManifest(
      { claude_code: { config: "src/hooks/hooks.json" } },
      configDir,
      "Miner",
    );

    expect(result).toBeArrayOfSize(3);
    expect(result![0]).toEqual({
      event: "SessionStart",
      command: `bun ${configDir}/src/hooks/Logger.ts`,
    });
    expect(result![1]).toEqual({
      event: "PostToolUse",
      command: `bun ${configDir}/src/hooks/Logger.ts`,
    });
    expect(result![2]).toEqual({
      event: "Stop",
      command: `bun ${configDir}/src/hooks/Logger.ts`,
    });
  });

  test("returns null for config-file that does not exist", () => {
    const result = resolveHooksFromManifest(
      { claude_code: { config: "nonexistent.json" } },
      "/fake/path",
      "TestPkg",
    );
    expect(result).toBeNull();
  });

  test("handles config JSON without outer hooks wrapper", async () => {
    // Some JSON files may have the events at the top level
    const hooksJson = {
      SessionStart: [{ type: "command", command: "bun $PKG_DIR/hook.ts" }],
    };
    const configDir = join(tmpDir, "flat-repo");
    await Bun.write(join(configDir, "hooks.json"), JSON.stringify(hooksJson));

    const result = resolveHooksFromManifest(
      { claude_code: { config: "hooks.json" } },
      configDir,
      "FlatPkg",
    );

    expect(result).toBeArrayOfSize(1);
    expect(result![0]).toEqual({
      event: "SessionStart",
      command: `bun ${configDir}/hook.ts`,
    });
  });
});

describe("hasHooks", () => {
  test("returns false for undefined", () => {
    expect(hasHooks(undefined)).toBe(false);
  });

  test("returns false for empty array", () => {
    expect(hasHooks([])).toBe(false);
  });

  test("returns true for non-empty inline array", () => {
    expect(hasHooks([{ event: "Stop", command: "/hook.ts" }])).toBe(true);
  });

  test("returns true for config-file reference", () => {
    expect(hasHooks({ claude_code: { config: "hooks.json" } })).toBe(true);
  });

  test("returns false for empty config-file reference", () => {
    expect(hasHooks({ claude_code: { config: "" } } as any)).toBe(false);
  });
});

describe("resolveHooksFromManifest $PAI_DIR substitution", () => {
  test("expands $PAI_DIR / ${PAI_DIR} to the provided paiDir", () => {
    const hooks = [
      { event: "Stop", command: "$PAI_DIR/hooks/Foo.ts" },
      { event: "PostToolUse", command: "${PAI_DIR}/hooks/Bar.ts" },
    ];
    const resolved = resolveHooksFromManifest(hooks, "/repo", "MyPkg", "/Users/me/.claude");
    expect(resolved).not.toBeNull();
    expect(resolved![0].command).toBe("/Users/me/.claude/hooks/Foo.ts");
    expect(resolved![1].command).toBe("/Users/me/.claude/hooks/Bar.ts");
  });

  test("leaves $PAI_DIR literal when paiDir is not provided (back-compat)", () => {
    const hooks = [{ event: "Stop", command: "$PAI_DIR/hooks/Foo.ts" }];
    const resolved = resolveHooksFromManifest(hooks, "/repo", "MyPkg");
    expect(resolved).not.toBeNull();
    expect(resolved![0].command).toBe("$PAI_DIR/hooks/Foo.ts");
  });

  test("substitution composes with $PKG_DIR and $<NAME>_DIR", () => {
    const hooks = [
      { event: "Stop", command: "${PAI_DIR}/runner.sh ${PKG_DIR}/handler.ts" },
      { event: "Start", command: "${MYPKG_DIR}/init.sh ${PAI_DIR}/audit.log" },
    ];
    const resolved = resolveHooksFromManifest(hooks, "/repo/install", "mypkg", "/Users/me/.claude");
    expect(resolved![0].command).toBe("/Users/me/.claude/runner.sh /repo/install/handler.ts");
    expect(resolved![1].command).toBe("/repo/install/init.sh /Users/me/.claude/audit.log");
  });
});

describe("findMissingHookFiles", () => {
  test("flags command whose absolute path does not exist", () => {
    const issues = findMissingHookFiles([
      { event: "Stop", command: "/nonexistent/path/to/handler.ts" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].event).toBe("Stop");
    expect(issues[0].missingPath).toBe("/nonexistent/path/to/handler.ts");
  });

  test("returns empty when command path exists", async () => {
    const path = join(tmpDir, "handler.ts");
    await writeFile(path, "// ok\n");
    const issues = findMissingHookFiles([
      { event: "Stop", command: path },
    ]);
    expect(issues).toHaveLength(0);
  });

  test("ignores non-path tokens like flags and bare commands", () => {
    const issues = findMissingHookFiles([
      { event: "Stop", command: "echo done" },
      { event: "Stop", command: "bun run --silent" },
    ]);
    expect(issues).toHaveLength(0);
  });

  test("does not false-positive on shell redirect targets", async () => {
    // The redirect target /tmp/output.log may or may not exist; either way it
    // is an output sink, not a required input file. Validation must skip it.
    const handler = join(tmpDir, "ok.ts");
    await writeFile(handler, "// ok\n");
    const missingSink = "/tmp/arc-test-redirect-" + Date.now() + ".log";
    const issues = findMissingHookFiles([
      { event: "Stop", command: `${handler} > ${missingSink}` },
      { event: "Stop", command: `${handler} 2> ${missingSink}` },
      { event: "Stop", command: `${handler} >> ${missingSink}` },
    ]);
    expect(issues).toHaveLength(0);
  });

  test("strips surrounding quotes before resolving", () => {
    const issues = findMissingHookFiles([
      { event: "Stop", command: `'/nonexistent/quoted.ts'` },
      { event: "Stop", command: `"/nonexistent/dquoted.ts"` },
    ]);
    expect(issues).toHaveLength(2);
  });
});
