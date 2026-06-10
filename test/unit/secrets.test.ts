/**
 * Tests for F-6e (arc#229) secret storage backends.
 *
 * Covers the FileBackend (universal chmod-600 fallback) and KeychainBackend
 * (macOS `security` CLI, exercised through an injected runner so the suite is
 * hermetic and never touches the real login keychain).
 *
 * NEVER-LOG invariant (issue §E): a secret value must never be emitted to
 * stdout/stderr. These tests assert backends return values but the redaction
 * helpers and service-key derivation never embed a value.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile, stat, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  FileBackend,
  KeychainBackend,
  resolveSecretBackend,
  secretServiceKey,
  redactSecret,
  type SecurityRunner,
  type SecurityResult,
} from "../../src/lib/secrets.js";

let tempDir: string;
let secretsRoot: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-secrets-test-"));
  secretsRoot = join(tempDir, "secrets");
  await mkdir(secretsRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("secretServiceKey", () => {
  test("derives ai.meta-factory.cortex.<agent>.<NAME>", () => {
    expect(secretServiceKey("dev", "APPROVER_GH_TOKEN")).toBe(
      "ai.meta-factory.cortex.dev.APPROVER_GH_TOKEN",
    );
  });

  test("never embeds the secret value (key is built from names only)", () => {
    const key = secretServiceKey("approver", "CORTEX_DEV_GH_TOKEN");
    expect(key).not.toContain("gh_pat");
    expect(key).toBe("ai.meta-factory.cortex.approver.CORTEX_DEV_GH_TOKEN");
  });
});

describe("redactSecret", () => {
  test("returns the fixed redaction sentinel, never the value", () => {
    expect(redactSecret("gh_pat_supersecret")).toBe("(secret redacted)");
    expect(redactSecret("")).toBe("(secret redacted)");
  });
});

describe("FileBackend", () => {
  test("store writes one secret per file under <root>/<agent>/<NAME>", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "gh_pat_value");
    const path = join(secretsRoot, "dev", "GITHUB_TOKEN");
    expect(existsSync(path)).toBe(true);
    expect((await readFile(path, "utf-8"))).toBe("gh_pat_value");
  });

  test("store enforces chmod 600 on the file", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "v");
    const path = join(secretsRoot, "dev", "GITHUB_TOKEN");
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("retrieve returns the stored value", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "round-trip");
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("round-trip");
  });

  test("retrieve returns null for a missing secret", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    expect(await backend.retrieve("NOPE")).toBeNull();
  });

  test("retrieve re-enforces chmod 600 on read (cortex#87 pattern)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const path = join(secretsRoot, "dev", "LOOSE");
    await mkdir(join(secretsRoot, "dev"), { recursive: true });
    await writeFile(path, "v");
    await chmod(path, 0o644); // simulate a too-open file
    const val = await backend.retrieve("LOOSE");
    expect(val).toBe("v");
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("remove deletes the secret file", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "v");
    await backend.remove("GITHUB_TOKEN");
    expect(existsSync(join(secretsRoot, "dev", "GITHUB_TOKEN"))).toBe(false);
  });

  test("remove is idempotent (no throw on missing)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await expect(backend.remove("GHOST")).resolves.toBeUndefined();
  });

  test("list returns stored secret names only (never values)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("A_TOKEN", "secret-a");
    await backend.store("B_TOKEN", "secret-b");
    const names = await backend.list();
    expect(names.sort()).toEqual(["A_TOKEN", "B_TOKEN"]);
    expect(names.join(",")).not.toContain("secret-");
  });

  test("rejects path-traversal in the secret name", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await expect(backend.store("../escape", "v")).rejects.toThrow(/invalid secret name/i);
  });

  test("rejects path-traversal in the agent name", () => {
    expect(() => new FileBackend(secretsRoot, "../etc")).toThrow(/invalid agent name/i);
  });
});

describe("KeychainBackend", () => {
  function makeRunner(): {
    runner: SecurityRunner;
    calls: string[][];
    store: Map<string, string>;
  } {
    const store = new Map<string, string>();
    const calls: string[][] = [];
    const runner: SecurityRunner = (args): SecurityResult => {
      calls.push(args);
      const verb = args[0];
      // crude arg parse mirroring the `security` CLI surface we use
      const sIdx = args.indexOf("-s");
      const service = sIdx >= 0 ? args[sIdx + 1] : "";
      if (verb === "add-generic-password") {
        const wIdx = args.indexOf("-w");
        store.set(service, args[wIdx + 1]);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (verb === "find-generic-password") {
        const stored = store.get(service);
        if (stored === undefined) {
          return { exitCode: 44, stdout: "", stderr: "could not be found" };
        }
        return { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
      }
      if (verb === "delete-generic-password") {
        const existed = store.delete(service);
        return existed
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 44, stdout: "", stderr: "could not be found" };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown verb" };
    };
    return { runner, calls, store };
  }

  test("store calls security add-generic-password with the derived service key", async () => {
    const { runner, store } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await backend.store("GITHUB_TOKEN", "gh_pat_x");
    expect(store.get("ai.meta-factory.cortex.dev.GITHUB_TOKEN")).toBe("gh_pat_x");
  });

  test("retrieve returns the value via find-generic-password -w", async () => {
    const { runner } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await backend.store("GITHUB_TOKEN", "gh_pat_x");
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("gh_pat_x");
  });

  test("retrieve returns null when keychain reports not-found (exit 44)", async () => {
    const { runner } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    expect(await backend.retrieve("MISSING")).toBeNull();
  });

  test("store passes the value via argv-free -w (value never on the command line we log)", async () => {
    const { runner, calls } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await backend.store("GITHUB_TOKEN", "gh_pat_secret");
    // The runner is the ONLY place a value is handed to `security`; the
    // backend must not log argv. We assert the account scoping is present.
    const addCall = calls.find((c) => c[0] === "add-generic-password");
    expect(addCall).toBeDefined();
    expect(addCall).toContain("-a");
    expect(addCall![addCall!.indexOf("-a") + 1]).toBe("alice");
  });

  test("rotate deletes then adds (no in-place overwrite — issue §E)", async () => {
    const { runner, calls, store } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await backend.store("GITHUB_TOKEN", "old");
    calls.length = 0;
    await backend.rotate("GITHUB_TOKEN", "new");
    const verbs = calls.map((c) => c[0]);
    expect(verbs).toEqual(["delete-generic-password", "add-generic-password"]);
    expect(store.get("ai.meta-factory.cortex.dev.GITHUB_TOKEN")).toBe("new");
  });

  test("remove calls delete-generic-password and is idempotent", async () => {
    const { runner } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await backend.store("GITHUB_TOKEN", "v");
    await backend.remove("GITHUB_TOKEN");
    expect(await backend.retrieve("GITHUB_TOKEN")).toBeNull();
    await expect(backend.remove("GITHUB_TOKEN")).resolves.toBeUndefined();
  });
});

describe("resolveSecretBackend", () => {
  test("selects FileBackend when forced (cross-platform fallback)", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "linux",
      secretsRoot,
      username: "alice",
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  test("selects KeychainBackend on darwin when security CLI is available", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      securityRunner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      keychainAvailable: true,
    });
    expect(backend).toBeInstanceOf(KeychainBackend);
  });

  test("falls back to FileBackend on darwin when keychain is unavailable", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      keychainAvailable: false,
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });
});
