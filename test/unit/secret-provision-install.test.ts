/**
 * Tests for F-6e (arc#229) install-time secret bridge
 * (`secret-provision-install.ts`) — the glue install.ts calls at the SECRETS
 * step. Hermetic via an injected FileBackend.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FileBackend } from "../../src/lib/secrets.js";
import {
  installTimeProvisionSecrets,
  buildSecretEnvForInstall,
} from "../../src/lib/secret-provision-install.js";
import type { ArcManifest, ArcPaths } from "../../src/types.js";

let tempDir: string;
let secretsRoot: string;
let arc: ArcPaths;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-secret-install-test-"));
  secretsRoot = join(tempDir, "secrets");
  await mkdir(secretsRoot, { recursive: true });
  // Only secretsDir is read by the bridge; stub the rest minimally.
  arc = { secretsDir: secretsRoot } as unknown as ArcPaths;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function manifest(secrets?: string[]): ArcManifest {
  return {
    name: "dev",
    version: "0.1.0",
    type: "agent",
    capabilities: secrets ? { secrets } : undefined,
  };
}

describe("installTimeProvisionSecrets", () => {
  test("no-op success when no secrets declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(manifest(), { arc, backend, quiet: true });
    expect(r.success).toBe(true);
    expect(r.stored).toEqual([]);
  });

  test("fromEnv stores declared secrets and reports names only", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(manifest(["APPROVER_GH_TOKEN"]), {
      arc,
      backend,
      fromEnv: true,
      env: { APPROVER_GH_TOKEN: "gh_pat_value" },
      quiet: true,
    });
    expect(r.success).toBe(true);
    expect(r.stored).toEqual(["APPROVER_GH_TOKEN"]);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBe("gh_pat_value");
    expect(JSON.stringify(r)).not.toContain("gh_pat_value");
  });

  test("skipSecrets stores nothing and reports the declared as skipped", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(manifest(["GITHUB_TOKEN"]), {
      arc,
      backend,
      skipSecrets: true,
      quiet: true,
    });
    expect(r.success).toBe(true);
    expect(r.skipped).toEqual(["GITHUB_TOKEN"]);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBeNull();
  });

  test("a backend store failure aborts the step (fail-closed)", async () => {
    const failing = new FileBackend(secretsRoot, "dev");
    failing.store = () => Promise.reject(new Error("boom"));
    const r = await installTimeProvisionSecrets(manifest(["GITHUB_TOKEN"]), {
      arc,
      backend: failing,
      fromEnv: true,
      env: { GITHUB_TOKEN: "v" },
      quiet: true,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Secret provisioning failed");
  });
});

describe("buildSecretEnvForInstall", () => {
  test("merges stored secrets into the (empty) base env", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("APPROVER_GH_TOKEN", "gh_pat_inject");
    const env = await buildSecretEnvForInstall(manifest(["APPROVER_GH_TOKEN"]), {
      arc,
      backend,
    });
    expect(env.APPROVER_GH_TOKEN).toBe("gh_pat_inject");
  });

  test("returns the base env unchanged when nothing declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await buildSecretEnvForInstall(manifest(), {
      arc,
      backend,
      baseEnv: { FOO: "bar" },
    });
    expect(env).toEqual({ FOO: "bar" });
  });

  test("omits a declared-but-unstored secret", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await buildSecretEnvForInstall(manifest(["MISSING"]), {
      arc,
      backend,
    });
    expect("MISSING" in env).toBe(false);
  });
});
