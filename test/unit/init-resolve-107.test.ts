/**
 * Tests for arc#107 — `resolveInitTarget` resolves the `arc init [name]`
 * arg + cwd into a `{name, targetDir}` tuple matching the new
 * init-in-place semantics.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveInitTarget,
  type ResolvedInitTarget,
} from "../../src/commands/init.js";

type OkResult = Extract<ResolvedInitTarget, { ok: true }>;
type FailResult = Extract<ResolvedInitTarget, { ok: false }>;

function ok(r: ResolvedInitTarget): OkResult {
  if (!r.ok) throw new Error(`Expected ok, got failure: ${r.detail}`);
  return r;
}

function fail(r: ResolvedInitTarget): FailResult {
  if (r.ok) throw new Error(`Expected failure, got ok`);
  return r;
}

describe("resolveInitTarget — arc#107 init-in-place", () => {
  test("argless → in-place, name = basename(cwd)", () => {
    const r = ok(resolveInitTarget({ cwd: "/tmp/test-blueprint" }));
    expect(r.name).toBe("test-blueprint");
    expect(r.targetDir).toBe("/tmp/test-blueprint");
  });

  test("`.` → identical to argless", () => {
    const r = ok(resolveInitTarget({ argName: ".", cwd: "/tmp/test-blueprint" }));
    expect(r.name).toBe("test-blueprint");
    expect(r.targetDir).toBe("/tmp/test-blueprint");
  });

  test("name matching cwd basename → in-place, no nested dir", () => {
    const r = ok(resolveInitTarget({ argName: "test-blueprint", cwd: "/tmp/test-blueprint" }));
    expect(r.name).toBe("test-blueprint");
    expect(r.targetDir).toBe("/tmp/test-blueprint");
  });

  test("name not matching cwd → ./<name>/ (no `arc-<type>-` prefix)", () => {
    const r = ok(resolveInitTarget({ argName: "MySkill", cwd: "/tmp/work" }));
    expect(r.name).toBe("MySkill");
    expect(r.targetDir).toBe("/tmp/work/MySkill");
  });

  test("dirOverride wins over both in-place and subdir modes", () => {
    const r1 = ok(resolveInitTarget({
      argName: ".",
      cwd: "/tmp/work",
      dirOverride: "/some/explicit/path",
    }));
    expect(r1.targetDir).toBe("/some/explicit/path");

    const r2 = ok(resolveInitTarget({
      argName: "MyTool",
      cwd: "/tmp/work",
      dirOverride: "/some/explicit/path",
    }));
    expect(r2.targetDir).toBe("/some/explicit/path");
  });

  test("whitespace-only argName treated as argless", () => {
    const r = ok(resolveInitTarget({ argName: "   ", cwd: "/tmp/foo" }));
    expect(r.name).toBe("foo");
  });

  test("path-traversal in argName is rejected", () => {
    expect(fail(resolveInitTarget({ argName: "../escape", cwd: "/tmp/foo" })).reason).toBe("invalid-name");
    expect(fail(resolveInitTarget({ argName: "foo/bar", cwd: "/tmp/foo" })).reason).toBe("invalid-name");
    expect(fail(resolveInitTarget({ argName: "foo\\bar", cwd: "/tmp/foo" })).reason).toBe("invalid-name");
    expect(fail(resolveInitTarget({ argName: "..", cwd: "/tmp/foo" })).reason).toBe("invalid-name");
  });

  test("argless from cwd whose basename is '..' is rejected", () => {
    expect(fail(resolveInitTarget({ cwd: "/tmp/.." })).reason).toBe("invalid-name");
  });

  test("dirOverride containing `..` is rejected (sage P148 security)", () => {
    expect(fail(resolveInitTarget({
      argName: "ok",
      cwd: "/tmp/work",
      dirOverride: "../escape",
    })).reason).toBe("invalid-dir");
    expect(fail(resolveInitTarget({
      argName: "ok",
      cwd: "/tmp/work",
      dirOverride: "/tmp/../escape",
    })).reason).toBe("invalid-dir");
  });

  test("empty dirOverride is rejected", () => {
    expect(fail(resolveInitTarget({
      argName: "ok",
      cwd: "/tmp/work",
      dirOverride: "",
    })).reason).toBe("invalid-dir");
  });

  test("failure carries name detail (sage P148 — name interpolation restored)", () => {
    const f = fail(resolveInitTarget({ argName: "../escape", cwd: "/tmp/foo" }));
    expect(f.detail).toContain("../escape");
  });

  test("arc#107 case 3: `arc init .` no longer produces literal '.' in path", () => {
    const r = ok(resolveInitTarget({ argName: ".", cwd: "/tmp/test-blueprint" }));
    expect(r.targetDir).not.toContain("arc-skill-.");
    expect(r.targetDir).not.toContain("./arc-skill-");
    expect(r.targetDir).toBe("/tmp/test-blueprint");
  });

  test("arc#107 case 2: `arc init <name>` matching cwd does not nest", () => {
    const r = ok(resolveInitTarget({ argName: "test-blueprint", cwd: "/tmp/test-blueprint" }));
    expect(r.targetDir).not.toContain("arc-skill-test-blueprint");
    expect(r.targetDir).toBe("/tmp/test-blueprint");
  });
});
