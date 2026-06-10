/**
 * Tests for F-6e (arc#229) install-time secret provisioning flow.
 *
 * provisionSecrets — prompt / --from-env / --skip-secrets resolution.
 * validateSecretPresence — which declared secrets are stored vs missing.
 * injectSecretsIntoEnv — retrieve from storage, merge into a child-process env.
 *
 * All exercised with an injected backend + injected prompt so the suite is
 * hermetic. NEVER-LOG: a value must never reach stdout — the prompt is the
 * only ingress and injection the only egress.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FileBackend } from "../../src/lib/secrets.js";
import {
  provisionSecrets,
  validateSecretPresence,
  injectSecretsIntoEnv,
} from "../../src/lib/secret-provision.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;
let secretsRoot: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-secret-provision-test-"));
  secretsRoot = join(tempDir, "secrets");
  await mkdir(secretsRoot, { recursive: true });
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

describe("provisionSecrets", () => {
  test("no-op when the manifest declares no secrets", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(), {
      agent: "dev",
      backend,
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("skipSecrets stores nothing and reports all declared as skipped", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["APPROVER_GH_TOKEN"]), {
      agent: "dev",
      backend,
      skipSecrets: true,
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["APPROVER_GH_TOKEN"]);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBeNull();
  });

  test("fromEnv reads existing env vars without prompting", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["APPROVER_GH_TOKEN"]), {
      agent: "dev",
      backend,
      fromEnv: true,
      env: { APPROVER_GH_TOKEN: "gh_pat_from_env" },
    });
    expect(result.stored).toEqual(["APPROVER_GH_TOKEN"]);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBe("gh_pat_from_env");
  });

  test("fromEnv skips a secret absent from the env (reported as skipped)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["CORTEX_DEV_GH_TOKEN"]), {
      agent: "dev",
      backend,
      fromEnv: true,
      env: {},
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["CORTEX_DEV_GH_TOKEN"]);
  });

  test("interactive prompt stores the entered value", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async (name) => {
        expect(name).toBe("GITHUB_TOKEN");
        return "typed-value";
      },
    });
    expect(result.stored).toEqual(["GITHUB_TOKEN"]);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("typed-value");
  });

  test("interactive prompt returning empty string skips that secret", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async () => "", // user pressed Return to skip
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["GITHUB_TOKEN"]);
  });

  test("never echoes a secret value through the result struct keys", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async () => "super-secret-value",
    });
    // The result reports NAMES only — never the value.
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });
});

describe("validateSecretPresence", () => {
  test("reports present and missing declared secrets", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("HAVE_TOKEN", "v");
    const report = await validateSecretPresence(
      manifest(["HAVE_TOKEN", "MISSING_TOKEN"]),
      { agent: "dev", backend },
    );
    expect(report.present).toEqual(["HAVE_TOKEN"]);
    expect(report.missing).toEqual(["MISSING_TOKEN"]);
    expect(report.ok).toBe(false);
  });

  test("ok=true when every declared secret is stored", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("HAVE_TOKEN", "v");
    const report = await validateSecretPresence(manifest(["HAVE_TOKEN"]), {
      agent: "dev",
      backend,
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  test("ok=true and empty lists when nothing is declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const report = await validateSecretPresence(manifest(), {
      agent: "dev",
      backend,
    });
    expect(report.ok).toBe(true);
    expect(report.present).toEqual([]);
    expect(report.missing).toEqual([]);
  });
});

describe("injectSecretsIntoEnv", () => {
  test("merges stored secrets into a base env", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("APPROVER_GH_TOKEN", "gh_pat_inject");
    const env = await injectSecretsIntoEnv(manifest(["APPROVER_GH_TOKEN"]), {
      agent: "dev",
      backend,
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.APPROVER_GH_TOKEN).toBe("gh_pat_inject");
  });

  test("omits a declared-but-unstored secret (does not inject undefined)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await injectSecretsIntoEnv(manifest(["MISSING"]), {
      agent: "dev",
      backend,
      baseEnv: {},
    });
    expect("MISSING" in env).toBe(false);
  });

  test("returns the base env unchanged when nothing is declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await injectSecretsIntoEnv(manifest(), {
      agent: "dev",
      backend,
      baseEnv: { FOO: "bar" },
    });
    expect(env).toEqual({ FOO: "bar" });
  });
});
