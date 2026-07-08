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
    // arc#276: new registrations write _arc_pkg, never the legacy _pai_pkg.
    expect(settings.hooks.PostToolUse[0]._arc_pkg).toBe("Grove");
    expect(settings.hooks.PostToolUse[0]._pai_pkg).toBeUndefined();
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
    // Untouched: registering "Grove" must not migrate a DIFFERENT
    // package's legacy tag — only the package being written for is
    // migrated on-touch (arc#276).
    expect(settings.hooks.PostToolUse[0]._pai_pkg).toBe("OtherPackage");
    expect(settings.hooks.PostToolUse[1]._arc_pkg).toBe("Grove");
    expect(settings.hooks.PostToolUse[1]._pai_pkg).toBeUndefined();
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

  test("reconciles legacy untagged duplicate hook registrations", async () => {
    const command = "${PAI_DIR}/hooks/CortexBashGuard.hook.ts";
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command }],
          },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command }],
          },
          {
            _pai_pkg: "Cortex",
            matcher: "Bash",
            hooks: [{ type: "command", command }],
          },
          {
            matcher: "Read",
            hooks: [{ type: "command", command }],
          },
          {
            _pai_pkg: "OtherPkg",
            matcher: "Bash",
            hooks: [{ type: "command", command }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await registerHooks(
      "Cortex",
      [{ event: "PreToolUse", matcher: "Bash", command }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    const bashCommandGroups = settings.hooks.PreToolUse.filter(
      (entry: { _arc_pkg?: string; _pai_pkg?: string; matcher?: string; hooks: { command: string }[] }) =>
        entry.matcher === "Bash" &&
        entry.hooks.some((hook) => hook.command === command),
    );

    expect(bashCommandGroups).toBeArrayOfSize(2);
    // OtherPkg's legacy tag is untouched (a different package's write does
    // not migrate it); Cortex's own entry is rewritten to _arc_pkg on this
    // touch, and the freshly-pushed replacement carries no _pai_pkg.
    expect(bashCommandGroups[0]._pai_pkg).toBe("OtherPkg");
    expect(bashCommandGroups[0]._arc_pkg).toBeUndefined();
    expect(bashCommandGroups[1]._arc_pkg).toBe("Cortex");
    expect(bashCommandGroups[1]._pai_pkg).toBeUndefined();
    expect(settings.hooks.PreToolUse).toBeArrayOfSize(3);
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Read",
      hooks: [{ type: "command", command }],
    });
  });

  test("includes matcher field for PreToolUse hooks", async () => {
    await registerHooks(
      "Grove",
      [{ event: "PreToolUse", command: "${PAI_DIR}/hooks/BashGuard.hook.ts", matcher: "Bash" }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(settings.hooks.PreToolUse[0]._arc_pkg).toBe("Grove");
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

  // arc#276: hooks.ts's shouldReplaceHookGroup treats an entry with NEITHER
  // _arc_pkg NOR _pai_pkg as claimable by any package (the "undefined"
  // ownership branch). This must survive the rename exactly as before.
  test("claims an untagged existing entry instead of duplicating it (undefined-ownership branch)", async () => {
    const command = "${PAI_DIR}/hooks/BashGuard.hook.ts";
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await registerHooks(
      "Grove",
      [{ event: "PreToolUse", matcher: "Bash", command }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    // No duplication: the untagged entry was claimed and replaced, not
    // appended alongside.
    expect(settings.hooks.PreToolUse).toBeArrayOfSize(1);
    expect(settings.hooks.PreToolUse[0]._arc_pkg).toBe("Grove");
    expect(settings.hooks.PreToolUse[0]._pai_pkg).toBeUndefined();
  });

  // arc#276 acceptance criterion: mixed-tag settings (some entries on
  // _arc_pkg, some still on legacy _pai_pkg, for the SAME package) must
  // round-trip through registerHooks without duplication, and the
  // migrate-on-touch pass must not disturb an unrelated package's entry.
  test("mixed-tag settings round-trip without duplication", async () => {
    const bashCommand = "${PAI_DIR}/hooks/BashGuard.hook.ts";
    const stopCommand = "${PAI_DIR}/hooks/Stop.hook.ts";
    const existing = {
      hooks: {
        PreToolUse: [
          {
            _pai_pkg: "Grove", // legacy tag, same package, different event group
            matcher: "Bash",
            hooks: [{ type: "command", command: bashCommand }],
          },
          {
            _pai_pkg: "OtherPkg", // unrelated package, must be left alone
            matcher: "Bash",
            hooks: [{ type: "command", command: bashCommand }],
          },
        ],
        Stop: [
          {
            _arc_pkg: "Grove", // already-current tag, same package
            hooks: [{ type: "command", command: stopCommand }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await registerHooks(
      "Grove",
      [{ event: "PreToolUse", matcher: "Bash", command: bashCommand }],
      settingsPath,
    );

    const settings = JSON.parse(await Bun.file(settingsPath).text());

    // PreToolUse: Grove's legacy entry is migrated + replaced (no dup),
    // OtherPkg's legacy entry is untouched.
    expect(settings.hooks.PreToolUse).toBeArrayOfSize(2);
    const groveEntry = settings.hooks.PreToolUse.find(
      (e: { _arc_pkg?: string }) => e._arc_pkg === "Grove",
    );
    expect(groveEntry).toBeDefined();
    expect(groveEntry._pai_pkg).toBeUndefined();
    const otherEntry = settings.hooks.PreToolUse.find(
      (e: { _pai_pkg?: string }) => e._pai_pkg === "OtherPkg",
    );
    expect(otherEntry).toBeDefined();

    // Stop: already-current _arc_pkg entry for Grove is untouched (not
    // duplicated, since registerHooks was not called for the Stop event).
    expect(settings.hooks.Stop).toBeArrayOfSize(1);
    expect(settings.hooks.Stop[0]._arc_pkg).toBe("Grove");
  });
});

describe("removeHooks", () => {
  // arc#276: this seeds entries with the LEGACY _pai_pkg tag (as a package
  // installed by a pre-rename arc would have on disk) and asserts removal
  // still works with no migration command ever having run.
  test("removes all legacy _pai_pkg-tagged hooks for a specific package", async () => {
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

  // arc#276: same scenario, but with the CURRENT _arc_pkg tag — this is
  // the tag registerHooks now writes, so removal must key on it too.
  test("removes all _arc_pkg-tagged hooks for a specific package", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _arc_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/hook.ts" }],
          },
          {
            _arc_pkg: "OtherPkg",
            hooks: [{ type: "command", command: "/other/hook.ts" }],
          },
        ],
        Stop: [
          {
            _arc_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/stop.ts" }],
          },
        ],
      },
    };
    await Bun.write(settingsPath, JSON.stringify(existing, null, 4));

    await removeHooks("Grove", settingsPath);

    const settings = JSON.parse(await Bun.file(settingsPath).text());
    expect(settings.hooks.PostToolUse).toBeArrayOfSize(1);
    expect(settings.hooks.PostToolUse[0]._arc_pkg).toBe("OtherPkg");
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
  test("returns hooks for a specific package tagged with legacy _pai_pkg", async () => {
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

  test("returns hooks for a specific package tagged with current _arc_pkg", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            _arc_pkg: "Grove",
            hooks: [{ type: "command", command: "/grove/hook.ts" }],
          },
          {
            _arc_pkg: "OtherPkg",
            hooks: [{ type: "command", command: "/other/hook.ts" }],
          },
        ],
        Stop: [
          {
            _arc_pkg: "Grove",
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

describe("resolveHooksFromManifest $HOME / ~ substitution", () => {
  test("expands $HOME and ${HOME} to process.env.HOME", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/test-home";
    try {
      const hooks = [
        { event: "Stop", command: "$HOME/scripts/cleanup.sh" },
        { event: "Start", command: "${HOME}/init.sh" },
      ];
      const resolved = resolveHooksFromManifest(hooks, "/repo", "MyPkg");
      expect(resolved).not.toBeNull();
      expect(resolved![0].command).toBe("/tmp/test-home/scripts/cleanup.sh");
      expect(resolved![1].command).toBe("/tmp/test-home/init.sh");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("expands leading ~/ to home", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/test-home";
    try {
      const hooks = [{ event: "Stop", command: "~/bin/cleanup.sh" }];
      const resolved = resolveHooksFromManifest(hooks, "/repo", "MyPkg");
      expect(resolved![0].command).toBe("/tmp/test-home/bin/cleanup.sh");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("expands whitespace-preceded ~/ inside a multi-token command", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/test-home";
    try {
      const hooks = [{ event: "Stop", command: "bun ~/bin/cleanup.sh --force" }];
      const resolved = resolveHooksFromManifest(hooks, "/repo", "MyPkg");
      expect(resolved![0].command).toBe("bun /tmp/test-home/bin/cleanup.sh --force");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("does NOT mangle bare ~ characters that aren't a tilde-path", () => {
    // Tokens like "rsync@host:~" use ~ literally. Only "~/" (tilde + slash)
    // should be expanded.
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/test-home";
    try {
      const hooks = [{ event: "Stop", command: "rsync host:~ /tmp" }];
      const resolved = resolveHooksFromManifest(hooks, "/repo", "MyPkg");
      expect(resolved![0].command).toBe("rsync host:~ /tmp");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("$HOME / $PAI_DIR / $PKG_DIR all compose in one command", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/test-home";
    try {
      const hooks = [
        {
          event: "Stop",
          command: "${PKG_DIR}/run.sh ${PAI_DIR}/audit.log $HOME/.cache/x.json",
        },
      ];
      const resolved = resolveHooksFromManifest(hooks, "/repo/install", "mypkg", "/Users/me/.claude");
      expect(resolved![0].command).toBe(
        "/repo/install/run.sh /Users/me/.claude/audit.log /tmp/test-home/.cache/x.json",
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
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
    const missingSink = `/tmp/arc-test-redirect-${Date.now()}.log`;
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
