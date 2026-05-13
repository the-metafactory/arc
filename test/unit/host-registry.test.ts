/**
 * Tests for arc#140 P3 host registry: resolveHost + orderTargetsForInstall.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveHost,
  orderTargetsForInstall,
  categorizeHost,
} from "../../src/lib/hosts/registry.js";

describe("resolveHost", () => {
  test("resolves claude-code", () => {
    const host = resolveHost("claude-code");
    expect(host.id).toBe("claude-code");
  });

  test("resolves cortex", () => {
    const host = resolveHost("cortex");
    expect(host.id).toBe("cortex");
  });

  test("resolves darwin-launchd (with forcePlatform for non-darwin CI)", () => {
    const host = resolveHost("darwin-launchd", {
      "darwin-launchd": { forcePlatform: "darwin" },
    });
    expect(host.id).toBe("darwin-launchd");
  });

  test("rejects linux-systemd (not yet implemented)", () => {
    expect(() => resolveHost("linux-systemd")).toThrow(/not yet implemented/);
  });

  test("threads overrides into the adapter", () => {
    const host = resolveHost("claude-code", {
      "claude-code": { root: "/tmp/test-claude" },
    });
    expect(host.paths.root).toBe("/tmp/test-claude");
  });
});

describe("categorizeHost", () => {
  test("registry hosts return 'registry'", () => {
    expect(categorizeHost("cortex")).toBe("registry");
    expect(categorizeHost("claude-code")).toBe("registry");
  });

  test("supervision hosts return 'supervision'", () => {
    expect(categorizeHost("darwin-launchd")).toBe("supervision");
    expect(categorizeHost("linux-systemd")).toBe("supervision");
  });
});

describe("orderTargetsForInstall", () => {
  test("registry hosts come before supervision hosts", () => {
    expect(orderTargetsForInstall(["darwin-launchd", "cortex"])).toEqual([
      "cortex",
      "darwin-launchd",
    ]);
  });

  test("declaration order preserved within a category", () => {
    expect(
      orderTargetsForInstall(["darwin-launchd", "linux-systemd", "claude-code", "cortex"]),
    ).toEqual(["claude-code", "cortex", "darwin-launchd", "linux-systemd"]);
  });

  test("all-registry list is unchanged", () => {
    expect(orderTargetsForInstall(["cortex", "claude-code"])).toEqual([
      "cortex",
      "claude-code",
    ]);
  });

  test("all-supervision list is unchanged", () => {
    expect(orderTargetsForInstall(["darwin-launchd", "linux-systemd"])).toEqual([
      "darwin-launchd",
      "linux-systemd",
    ]);
  });

  test("empty array → empty", () => {
    expect(orderTargetsForInstall([])).toEqual([]);
  });

  test("standalone-bot shape: cortex + darwin-launchd", () => {
    expect(orderTargetsForInstall(["cortex", "darwin-launchd"])).toEqual([
      "cortex",
      "darwin-launchd",
    ]);
  });
});
