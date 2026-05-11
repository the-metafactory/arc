import { describe, test, expect } from "bun:test";
import { hostPathFor } from "../../src/lib/hosts/dispatch.js";
import { getDefaultHost } from "../../src/lib/paths.js";

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
