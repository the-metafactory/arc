/**
 * Regression tests for sage P3 review findings (arc#143).
 *
 * Three findings:
 *   1. (important) categorizeHost lacks exhaustiveness check
 *   2. (important) installPerTarget uses unsafe `as` cast for darwin-launchd
 *   3. (suggestion) renderPlist regex doesn't match hyphenated tokens
 *
 * Each finding gets a positive test (verify the new behavior) plus the
 * regression scenario where applicable.
 */

import { describe, test, expect } from "bun:test";
import { renderPlist } from "../../src/lib/hosts/launchd-install.js";
import { isDarwinLaunchdHost, createDarwinLaunchdHost } from "../../src/lib/hosts/darwin-launchd.js";
import { createCortexHost } from "../../src/lib/hosts/cortex.js";

describe("sage review #1 — categorizeHost exhaustiveness guard", () => {
  // Compile-time: adding a HostId to the union without adding a case to
  // categorizeHost surfaces as a `never` mismatch (verified by `bun x tsc --noEmit`).
  // Runtime test: passing an unknown value at the type-erased boundary throws.
  test("unknown HostId throws at runtime", async () => {
    const { categorizeHost } = await import("../../src/lib/hosts/registry.js");
    expect(() => categorizeHost("totally-unknown" as any)).toThrow(/Unhandled HostId/);
  });
});

describe("sage review #2 — isDarwinLaunchdHost type guard", () => {
  test("returns true for a real darwin-launchd host", () => {
    const host = createDarwinLaunchdHost({ forcePlatform: "darwin" });
    expect(isDarwinLaunchdHost(host)).toBe(true);
  });

  test("returns false for a cortex host (different id)", () => {
    const host = createCortexHost();
    expect(isDarwinLaunchdHost(host)).toBe(false);
  });

  test("returns false when id matches but plistDir is missing", () => {
    const synthetic = {
      id: "darwin-launchd" as const,
      paths: {
        root: "", skillsDir: "", agentsDir: "", promptsDir: "", binDir: "",
        settingsPath: "",
        // plistDir intentionally absent — simulates a future refactor mistake
      } as any,
      detect: () => false,
      supports: () => false,
    };
    expect(isDarwinLaunchdHost(synthetic as any)).toBe(false);
  });
});

describe("sage review #3 — renderPlist supports hyphenated tokens", () => {
  test("hyphenated token in template + tokens map substitutes", () => {
    const out = renderPlist("X={{MY-TOKEN}}", { "MY-TOKEN": "ok" });
    expect(out).toBe("X=ok");
  });

  test("hyphenated token not in map passes through verbatim", () => {
    const out = renderPlist("X={{MY-TOKEN}}", { OTHER: "x" });
    expect(out).toBe("X={{MY-TOKEN}}");
  });

  test("mixed underscore and hyphen tokens both work", () => {
    const out = renderPlist("{{NATS_URL}} and {{ai-meta-factory}}", {
      NATS_URL: "nats://x",
      "ai-meta-factory": "yes",
    });
    expect(out).toBe("nats://x and yes");
  });
});
