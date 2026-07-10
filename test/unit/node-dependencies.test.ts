import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import {
  installNodeDependencies,
  reportNodeDependencyResult,
} from "../../src/lib/artifact-installer.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "arc-node-deps-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("installNodeDependencies", () => {
  test("no-ops when there is no package.json", () => {
    const result = installNodeDependencies(testDir);
    expect(result).toEqual({ ran: false, success: true, usedFrozenLockfile: false });
  });

  test(
    "runs bun install --production and populates node_modules for a real dependency",
    async () => {
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { yaml: "^2.7.0" } }),
      );

      const result = installNodeDependencies(testDir);

      expect(result.ran).toBe(true);
      expect(result.success).toBe(true);
      expect(result.usedFrozenLockfile).toBe(false); // no lockfile committed yet
      expect(existsSync(join(testDir, "node_modules", "yaml"))).toBe(true);
    },
    30_000,
  );

  test(
    "is idempotent — re-running against an already-satisfied node_modules still succeeds",
    async () => {
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { yaml: "^2.7.0" } }),
      );

      const first = installNodeDependencies(testDir);
      expect(first.success).toBe(true);

      // `--production` intentionally does not write a lockfile (verified
      // against bun 1.2.23), so a repo with no COMMITTED lockfile stays on
      // the no-frozen-lockfile path across repeated installs — bun install
      // is still idempotent (a fast no-op re-resolve), just not frozen.
      const second = installNodeDependencies(testDir);
      expect(second.ran).toBe(true);
      expect(second.success).toBe(true);
      expect(second.usedFrozenLockfile).toBe(false);
      expect(existsSync(join(testDir, "node_modules", "yaml"))).toBe(true);
    },
    30_000,
  );

  test(
    "uses --frozen-lockfile when the bundle ships a committed lockfile (the real-world clone case)",
    async () => {
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { yaml: "^2.7.0" } }),
      );
      // Simulate a bundle repo cloned WITH a committed lockfile: generate one
      // via a plain (non --production) install, matching how an author would
      // have committed it after `bun install` in their own repo.
      Bun.spawnSync(["bun", "install"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(join(testDir, "bun.lock"))).toBe(true);
      await rm(join(testDir, "node_modules"), { recursive: true, force: true });

      const result = installNodeDependencies(testDir);
      expect(result.ran).toBe(true);
      expect(result.success).toBe(true);
      expect(result.usedFrozenLockfile).toBe(true);
      expect(existsSync(join(testDir, "node_modules", "yaml"))).toBe(true);
    },
    30_000,
  );

  test(
    "surfaces a failure (does not throw) when a dependency cannot resolve",
    async () => {
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          dependencies: { "arc-284-fixture-does-not-exist-xyz": "^1.0.0" },
        }),
      );

      const result = installNodeDependencies(testDir);

      expect(result.ran).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    },
    30_000,
  );
});

describe("reportNodeDependencyResult", () => {
  test("is a no-op when nothing ran", () => {
    // Should not throw when given a not-ran result.
    expect(() =>
      reportNodeDependencyResult({ ran: false, success: true, usedFrozenLockfile: false }, "pkg"),
    ).not.toThrow();
  });

  test("does not throw on a failure result (writes to stderr, doesn't throw)", () => {
    expect(() =>
      reportNodeDependencyResult(
        { ran: true, success: false, usedFrozenLockfile: false, error: "boom" },
        "pkg",
      ),
    ).not.toThrow();
  });
});
