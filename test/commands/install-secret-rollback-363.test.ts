/**
 * arc#363 — install rollback when the post-landing secret-env build throws.
 *
 * The SECRETS env-build (`buildSecretEnvForInstall`) runs AFTER the skill/bin
 * symlinks + CLI shim have landed but BEFORE the rollback-owning transaction
 * starts. A throw there (the exact failure mode #363 hit with an object-form
 * secret) must not strand a half-install: the clone, the artifact symlinks, and
 * the shim all have to be unwound, and the ORIGINAL error must surface — not be
 * masked by a rollback failure.
 *
 * Driven through the real `install()` with an injected secret backend whose
 * `retrieve` throws (the `secretBackendInstance` test seam), so the failure is
 * exercised end-to-end rather than at the helper boundary.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";
import type { SecretBackend } from "../../src/lib/secrets.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

/** A backend whose retrieve blows up; store/list are never reached on this path. */
function throwingRetrieveBackend(message: string): SecretBackend {
  return {
    store: async () => {},
    retrieve: async () => {
      throw new Error(message);
    },
    remove: async () => {},
    list: async () => [],
    rotate: async () => {},
  };
}

describe("install rollback on secret-env build failure (arc#363)", () => {
  test("a throwing retrieve unwinds clone + symlinks + shim and surfaces the original error", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "SecretRollback",
      withCli: true,
      capabilities: { secrets: ["ROLLBACK_TOKEN"] },
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      secretBackendInstance: throwingRetrieveBackend("keychain unavailable: retrieve boom"),
    });

    // The install fails, and the backend's own error survives to the caller —
    // the rollback must not swallow or replace it.
    expect(result.success).toBe(false);
    expect(result.error).toContain("retrieve boom");

    // Clone removed (no orphan under repos/).
    expect(existsSync(join(env.arc.reposDir, "mock-SecretRollback"))).toBe(false);

    // Artifact symlinks unwound: the skill drop and the CLI bin symlink.
    expect(existsSync(join(env.host.paths.skillsDir, "SecretRollback"))).toBe(false);
    expect(existsSync(join(env.host.paths.binDir, "secretrollback"))).toBe(false);

    // The CLI shim in arc's shim dir is gone too.
    expect(existsSync(join(env.arc.shimDir, "secretrollback"))).toBe(false);

    // Nothing was recorded in the DB (the row is the transaction's last step;
    // we never reached it).
    expect(getSkill(env.db, "SecretRollback")).toBeNull();
  });

  test("a successful install of the same package still lands (control)", async () => {
    // Same shape, but no injected throwing backend — proves the rollback test's
    // teardown assertions are meaningful (the artifacts DO land on the happy
    // path). --yes + non-TTY leaves the declared secret unprovisioned, which is
    // fine: the real file backend's retrieve returns null, env-build omits it.
    const repo = await createMockSkillRepo(env.root, {
      name: "SecretRollbackOk",
      withCli: true,
      capabilities: { secrets: ["ROLLBACK_TOKEN"] },
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(env.host.paths.skillsDir, "SecretRollbackOk"))).toBe(true);
    expect(existsSync(join(env.host.paths.binDir, "secretrollbackok"))).toBe(true);
  });
});
