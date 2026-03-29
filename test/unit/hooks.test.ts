import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  registerHooks,
  removeHooks,
  listPackageHooks,
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
