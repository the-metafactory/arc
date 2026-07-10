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
    "runs bun install and populates node_modules for a real dependency",
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
      expect(first.usedFrozenLockfile).toBe(false); // no lockfile existed before this run

      // A plain `bun install` (no --production, arc#289 FIX 3) writes
      // bun.lock as a side effect even on an unfrozen run. So the SECOND
      // call now sees a lockfile that was present BEFORE it ran and takes
      // the --frozen-lockfile path — which succeeds, since nothing changed.
      // Still idempotent (a fast no-op re-resolve), just frozen this time.
      const second = installNodeDependencies(testDir);
      expect(second.ran).toBe(true);
      expect(second.success).toBe(true);
      expect(second.usedFrozenLockfile).toBe(true);
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
      // via a plain install, matching how an author would have committed it
      // after `bun install` in their own repo.
      Bun.spawnSync(["bun", "install"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(join(testDir, "bun.lock"))).toBe(true);
      await rm(join(testDir, "node_modules"), { recursive: true, force: true });

      const result = installNodeDependencies(testDir);
      expect(result.ran).toBe(true);
      expect(result.success).toBe(true);
      expect(result.usedFrozenLockfile).toBe(true);
      expect(result.staleLockfileRecovered).toBeFalsy();
      expect(existsSync(join(testDir, "node_modules", "yaml"))).toBe(true);
    },
    30_000,
  );

  test(
    "recovers from a stale lockfile via an unfrozen retry (arc#289 blocker)",
    async () => {
      // Commit a lockfile for ONE dependency, matching what a real plugin
      // bundle repo looks like after its author ran `bun install` and
      // committed bun.lock.
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { yaml: "^2.7.0" } }),
      );
      Bun.spawnSync(["bun", "install"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(join(testDir, "bun.lock"))).toBe(true);
      await rm(join(testDir, "node_modules"), { recursive: true, force: true });

      // Drift package.json AFTER the lockfile was committed — e.g. a
      // dependency was added and the author forgot to re-run `bun install`.
      // `bun install --frozen-lockfile` hard-errors against this.
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          dependencies: { yaml: "^2.7.0", "is-odd": "^3.0.1" },
        }),
      );

      const result = installNodeDependencies(testDir);

      expect(result.ran).toBe(true);
      expect(result.success).toBe(true);
      expect(result.usedFrozenLockfile).toBe(false); // recovered via the unfrozen retry
      expect(result.staleLockfileRecovered).toBe(true);
      expect(existsSync(join(testDir, "node_modules", "yaml"))).toBe(true);
      expect(existsSync(join(testDir, "node_modules", "is-odd"))).toBe(true);
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

  test(
    "a genuine failure survives even after a lockfile is present (frozen AND unfrozen both fail)",
    async () => {
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { yaml: "^2.7.0" } }),
      );
      Bun.spawnSync(["bun", "install"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
      expect(existsSync(join(testDir, "bun.lock"))).toBe(true);
      await rm(join(testDir, "node_modules"), { recursive: true, force: true });

      // Drift in an unresolvable dependency — both the frozen attempt AND
      // the unfrozen retry must fail, and the failure must surface (not be
      // swallowed as a false "recovered").
      await writeFile(
        join(testDir, "package.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          dependencies: { yaml: "^2.7.0", "arc-284-fixture-does-not-exist-xyz": "^1.0.0" },
        }),
      );

      const result = installNodeDependencies(testDir);

      expect(result.ran).toBe(true);
      expect(result.success).toBe(false);
      expect(result.staleLockfileRecovered).toBeFalsy();
      expect(result.error).toBeTruthy();
    },
    30_000,
  );
});

describe("reportNodeDependencyResult", () => {
  test("is a no-op when nothing ran", () => {
    // Should not throw when given a not-ran result.
    expect(() =>
      reportNodeDependencyResult({ ran: false, success: true, usedFrozenLockfile: false }, "pkg", false),
    ).not.toThrow();
  });

  test("does not throw on a failure result (writes to stderr, doesn't throw)", () => {
    expect(() =>
      reportNodeDependencyResult(
        { ran: true, success: false, usedFrozenLockfile: false, error: "boom" },
        "pkg",
        false,
      ),
    ).not.toThrow();
  });

  test("does not throw when a success carries staleLockfileRecovered (WARN, not failure)", () => {
    expect(() =>
      reportNodeDependencyResult(
        {
          ran: true,
          success: true,
          usedFrozenLockfile: false,
          staleLockfileRecovered: true,
          packageCount: 3,
        },
        "pkg",
        true,
      ),
    ).not.toThrow();
  });
});
