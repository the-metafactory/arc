/**
 * Tests for arc#107 — `resolveInitTarget` resolves the `arc init [name]`
 * arg + cwd into a `{name, targetDir, inPlace}` tuple matching the new
 * init-in-place semantics.
 */

import { describe, test, expect } from "bun:test";
import { resolveInitTarget } from "../../src/commands/init.js";

describe("resolveInitTarget — arc#107 init-in-place", () => {
  test("argless → in-place, name = basename(cwd)", () => {
    const r = resolveInitTarget({ cwd: "/tmp/test-blueprint" });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("test-blueprint");
    expect(r!.targetDir).toBe("/tmp/test-blueprint");
    expect(r!.inPlace).toBe(true);
  });

  test("`.` → identical to argless", () => {
    const r = resolveInitTarget({ argName: ".", cwd: "/tmp/test-blueprint" });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("test-blueprint");
    expect(r!.targetDir).toBe("/tmp/test-blueprint");
    expect(r!.inPlace).toBe(true);
  });

  test("name matching cwd basename → in-place, no nested dir", () => {
    const r = resolveInitTarget({ argName: "test-blueprint", cwd: "/tmp/test-blueprint" });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("test-blueprint");
    expect(r!.targetDir).toBe("/tmp/test-blueprint");
    expect(r!.inPlace).toBe(true);
  });

  test("name not matching cwd → ./<name>/ (no `arc-<type>-` prefix)", () => {
    const r = resolveInitTarget({ argName: "MySkill", cwd: "/tmp/work" });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("MySkill");
    expect(r!.targetDir).toBe("/tmp/work/MySkill");
    expect(r!.inPlace).toBe(false);
  });

  test("dirOverride wins over both in-place and subdir modes", () => {
    const r1 = resolveInitTarget({
      argName: ".",
      cwd: "/tmp/work",
      dirOverride: "/some/explicit/path",
    });
    expect(r1!.targetDir).toBe("/some/explicit/path");

    const r2 = resolveInitTarget({
      argName: "MyTool",
      cwd: "/tmp/work",
      dirOverride: "/some/explicit/path",
    });
    expect(r2!.targetDir).toBe("/some/explicit/path");
  });

  test("whitespace-only argName treated as argless", () => {
    const r = resolveInitTarget({ argName: "   ", cwd: "/tmp/foo" });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("foo");
    expect(r!.inPlace).toBe(true);
  });

  test("path-traversal in argName is rejected (returns null)", () => {
    expect(resolveInitTarget({ argName: "../escape", cwd: "/tmp/foo" })).toBeNull();
    expect(resolveInitTarget({ argName: "foo/bar", cwd: "/tmp/foo" })).toBeNull();
    expect(resolveInitTarget({ argName: "foo\\bar", cwd: "/tmp/foo" })).toBeNull();
    expect(resolveInitTarget({ argName: "..", cwd: "/tmp/foo" })).toBeNull();
  });

  test("argless from a dot-containing cwd basename rejects (defense)", () => {
    // /tmp/foo.bar — basename is "foo.bar". `..` regex doesn't match.
    const r = resolveInitTarget({ cwd: "/tmp/foo.bar" });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("foo.bar");
  });

  test("argless from cwd whose basename has dot-dot traversal is rejected", () => {
    // Edge case: a cwd basename of literally ".." (extremely rare, but a
    // safety check).
    const r = resolveInitTarget({ cwd: "/tmp/.." });
    expect(r).toBeNull();
  });

  test("arc#107 reproduction case 3: `arc init .` no longer produces literal '.' in path", () => {
    // The bug: pre-fix, `arc init .` concat'd `arc-skill-.` as the dir name.
    // Post-fix, `.` resolves to cwd basename, targetDir = cwd.
    const r = resolveInitTarget({ argName: ".", cwd: "/tmp/test-blueprint" });
    expect(r!.targetDir).not.toContain("arc-skill-.");
    expect(r!.targetDir).not.toContain("./arc-skill-");
    expect(r!.targetDir).toBe("/tmp/test-blueprint");
  });

  test("arc#107 reproduction case 2: `arc init <name>` matching cwd does not nest", () => {
    // The bug: pre-fix produced ./arc-skill-test-blueprint/ even when cwd
    // basename was test-blueprint. Post-fix, in-place.
    const r = resolveInitTarget({ argName: "test-blueprint", cwd: "/tmp/test-blueprint" });
    expect(r!.targetDir).not.toContain("arc-skill-test-blueprint");
    expect(r!.targetDir).toBe("/tmp/test-blueprint");
    expect(r!.inPlace).toBe(true);
  });
});
