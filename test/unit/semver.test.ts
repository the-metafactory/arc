import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion, satisfiesRange } from "../../src/lib/semver.js";

describe("parseVersion", () => {
  test("parses full semver", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  test("pads missing components with 0", () => {
    expect(parseVersion("1")).toEqual([1, 0, 0]);
    expect(parseVersion("1.2")).toEqual([1, 2, 0]);
  });

  test("strips a leading v and prerelease/build metadata", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+build5")).toEqual([1, 2, 3]);
  });

  test("unparsable input degrades to [0,0,0] rather than throwing", () => {
    expect(parseVersion("not-a-version")).toEqual([0, 0, 0]);
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.1.0", "1.2.0")).toBe(-1);
    expect(compareVersions("1.2.1", "1.2.0")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("satisfiesRange", () => {
  test("empty/unparsable range always satisfies", () => {
    expect(satisfiesRange("1.0.0", "")).toBe(true);
    expect(satisfiesRange("1.0.0", "   ")).toBe(true);
  });

  test("bare version means exact match", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });

  test(">= / <= / > / < comparisons", () => {
    expect(satisfiesRange("2.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("0.9.0", ">=1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "<=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.1", "<=1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.1", ">1.0.0")).toBe(true);
    expect(satisfiesRange("0.9.9", "<1.0.0")).toBe(true);
  });

  test("AND range: >=X <Y", () => {
    expect(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesRange("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  test("caret (^) range — same major, matches ADR-0024's sdkRange style", () => {
    expect(satisfiesRange("1.9.9", "^1")).toBe(true);
    expect(satisfiesRange("1.0.0", "^1")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1")).toBe(false);
    expect(satisfiesRange("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfiesRange("1.1.0", "^1.2.0")).toBe(false); // below the floor
  });

  test("caret range on a 0.x version narrows to same minor (npm semantics)", () => {
    expect(satisfiesRange("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
  });

  test("tilde (~) range — patch-level flexibility", () => {
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesRange("1.2.0", "~1.2.0")).toBe(true);
  });

  test("real-world compat check: cortex plugin depends_on.skills range", () => {
    // e.g. depends_on.skills: [{ name: "cortex", version: ">=6.0.0" }]
    expect(satisfiesRange("6.3.0", ">=6.0.0")).toBe(true);
    expect(satisfiesRange("5.9.0", ">=6.0.0")).toBe(false);
  });

  // arc#289 review: fail-open regressions, pinned against the review's
  // yours-vs-npm divergence table. Every row below now agrees with npm.
  test("bare wildcard '*' / 'x' / 'X' always satisfies", () => {
    expect(satisfiesRange("1.5.0", "*")).toBe(true);
    expect(satisfiesRange("0.0.1", "*")).toBe(true);
    expect(satisfiesRange("1.5.0", "x")).toBe(true);
    expect(satisfiesRange("1.5.0", "X")).toBe(true);
  });

  test("X-ranges: '1.x' / '1.2.x' / bare partial versions", () => {
    expect(satisfiesRange("1.5.0", "1.x")).toBe(true);
    expect(satisfiesRange("2.0.0", "1.x")).toBe(false);
    expect(satisfiesRange("0.9.9", "1.x")).toBe(false);
    expect(satisfiesRange("1.2.9", "1.2.x")).toBe(true);
    expect(satisfiesRange("1.3.0", "1.2.x")).toBe(false);
    // Bare partial versions ("1", "1.2") are X-ranges too, npm semantics.
    expect(satisfiesRange("1.9.0", "1")).toBe(true);
    expect(satisfiesRange("2.0.0", "1")).toBe(false);
  });

  test("whitespace after a comparator operator (legal npm syntax, natural in YAML)", () => {
    expect(satisfiesRange("1.5.0", ">= 1.0.0")).toBe(true);
    expect(satisfiesRange("6.3.0", ">= 1.0.0")).toBe(true);
    expect(satisfiesRange("0.9.0", ">= 1.0.0")).toBe(false);
    expect(satisfiesRange("1.5.0", ">= 1.0.0 <= 2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.1", ">= 1.0.0 <= 2.0.0")).toBe(false);
  });

  test("caret-on-zero: '^0' and '^0.x' (missing segments are wildcards)", () => {
    expect(satisfiesRange("0.5.0", "^0")).toBe(true);
    expect(satisfiesRange("0.0.5", "^0")).toBe(true);
    expect(satisfiesRange("1.0.0", "^0")).toBe(false);
    expect(satisfiesRange("0.0.5", "^0.0")).toBe(true);
    expect(satisfiesRange("0.1.0", "^0.0")).toBe(false);
    // Fully-specified caret-on-zero is unaffected (already correct).
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
  });

  test("OR ranges ('||')", () => {
    expect(satisfiesRange("6.3.0", ">=1.0.0 || >=2.0.0")).toBe(true);
    expect(satisfiesRange("6.3.0", ">=1.0.0 <2.0.0 || >=6.0.0 <7.0.0")).toBe(true);
    expect(satisfiesRange("2.5.0", ">=1.0.0 <2.0.0 || >=6.0.0 <7.0.0")).toBe(false);
  });

  test("unparsable clause never throws and fails open (satisfied)", () => {
    expect(() => satisfiesRange("6.3.0", "garbage")).not.toThrow();
    expect(satisfiesRange("6.3.0", "garbage")).toBe(true);
  });

  test("pre-release: '1.0.0-beta' does NOT satisfy ranges that don't opt into pre-releases (npm semantics)", () => {
    expect(satisfiesRange("1.0.0-beta", ">=1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0-beta", "^1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0-beta", "1.0.0")).toBe(false);
    // An installed pre-release SDK build must not silently satisfy a
    // released-only upper-bound guard (the concrete cortex#7.0.0-rc.1 case).
    expect(satisfiesRange("7.0.0-rc.1", "<7.0.0")).toBe(false);
    // A clause that itself names the SAME pre-release opts back in.
    expect(satisfiesRange("1.0.0-beta", "1.0.0-beta")).toBe(true);
  });
});
