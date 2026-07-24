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
  isSharedOrCiHost,
  normalizeDeclaredSecrets,
  SecretListUnsupportedError,
  type SecurityRunner,
  type SecurityResult,
} from "../../src/lib/secrets.js";
import { readdir } from "fs/promises";

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

  // arc#234 review nit 1: atomic write.
  test("overwrite preserves 0600 and leaves no temp orphan (atomic write)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "first");
    await backend.store("GITHUB_TOKEN", "second");
    const path = join(secretsRoot, "dev", "GITHUB_TOKEN");
    expect(await readFile(path, "utf-8")).toBe("second");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // No leftover `.NAME.<rand>.tmp` files in the agent dir.
    const entries = await readdir(join(secretsRoot, "dev"));
    expect(entries.some((e) => e.includes(".tmp"))).toBe(false);
    expect(entries).toEqual(["GITHUB_TOKEN"]);
  });

  test("list ignores temp + dotfiles (only env-var-shaped names)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("REAL_TOKEN", "v");
    // Drop a stray dotfile/temp that an interrupted write could leave.
    await mkdir(join(secretsRoot, "dev"), { recursive: true });
    await writeFile(join(secretsRoot, "dev", ".REAL_TOKEN.abc123.tmp"), "junk");
    const names = await backend.list();
    expect(names).toEqual(["REAL_TOKEN"]);
  });

  test("round-trips a value byte-for-byte, including a trailing newline", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("MULTILINE", "line1\nline2\n");
    expect(await backend.retrieve("MULTILINE")).toBe("line1\nline2\n");
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

  // arc#234 review nit 2: list() must NOT silently return [] (would lie
  // "no secrets" on macOS). It rejects with a typed unsupported error.
  test("list rejects with SecretListUnsupportedError (never a silent empty list)", async () => {
    const { runner } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await expect(backend.list()).rejects.toBeInstanceOf(SecretListUnsupportedError);
  });

  // arc#234 review nit 4: strip ONLY the single newline `security -w` appends;
  // a value that itself ends in "\n" must round-trip correctly.
  test("retrieve strips exactly one trailing newline that security adds", async () => {
    const { runner, store } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    // Simulate a stored value that genuinely ends in "\n"; on store we wrote it
    // verbatim, and `security -w` prints it back with ITS extra "\n" appended.
    store.set("ai.meta-factory.cortex.dev.NL_TOKEN", "value-with-nl\n");
    const got = await backend.retrieve("NL_TOKEN");
    expect(got).toBe("value-with-nl\n");
  });

  test("retrieve of a no-newline value is unchanged", async () => {
    const { runner } = makeRunner();
    const backend = new KeychainBackend("dev", "alice", runner);
    await backend.store("PLAIN", "no-newline-here");
    expect(await backend.retrieve("PLAIN")).toBe("no-newline-here");
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

  test("selects KeychainBackend on a NON-shared darwin host when security CLI is available", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      securityRunner: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      keychainAvailable: true,
      sharedHost: false,
    });
    expect(backend).toBeInstanceOf(KeychainBackend);
  });

  test("falls back to FileBackend on darwin when keychain is unavailable", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      keychainAvailable: false,
      sharedHost: false,
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  // arc#234 review MAJOR: on a shared/CI macOS host, prefer the file backend so
  // the Keychain `security -w` argv-exposure window is opt-in on dev boxes only.
  test("auto prefers FileBackend on a SHARED darwin host even when keychain is available", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      keychainAvailable: true,
      sharedHost: true,
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  test("auto detects a CI host via the CI env var and prefers FileBackend", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      keychainAvailable: true,
      env: { CI: "true" },
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  test("--secret-backend keychain forces Keychain even on a shared darwin host", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      keychainAvailable: true,
      sharedHost: true,
      backendChoice: "keychain",
    });
    expect(backend).toBeInstanceOf(KeychainBackend);
  });

  test("--secret-backend keychain on a non-darwin host falls back to FileBackend", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "linux",
      secretsRoot,
      username: "alice",
      backendChoice: "keychain",
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  test("--secret-backend file forces FileBackend on a non-shared darwin host", () => {
    const backend = resolveSecretBackend("dev", {
      platform: "darwin",
      secretsRoot,
      username: "alice",
      keychainAvailable: true,
      sharedHost: false,
      backendChoice: "file",
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });
});

describe("isSharedOrCiHost", () => {
  test("true under common CI markers", () => {
    expect(isSharedOrCiHost({ CI: "true" })).toBe(true);
    expect(isSharedOrCiHost({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isSharedOrCiHost({ ARC_SHARED_HOST: "1" })).toBe(true);
  });

  test("false on a clean single-user env", () => {
    expect(isSharedOrCiHost({})).toBe(false);
    expect(isSharedOrCiHost({ CI: "" })).toBe(false);
    expect(isSharedOrCiHost({ CI: "0" })).toBe(false);
    expect(isSharedOrCiHost({ CI: "false" })).toBe(false);
  });
});

// ── arc#363: normalizeDeclaredSecrets — the single fold both forms pass ──────
describe("normalizeDeclaredSecrets (arc#363)", () => {
  test("undefined → []", () => {
    expect(normalizeDeclaredSecrets(undefined)).toEqual([]);
  });

  test("bare string → { name, optional:false, reason:'' }", () => {
    expect(normalizeDeclaredSecrets(["GITHUB_TOKEN"])).toEqual([
      { name: "GITHUB_TOKEN", optional: false, reason: "" },
    ]);
  });

  test("object form carries name, optional, reason", () => {
    expect(
      normalizeDeclaredSecrets([{ name: "LLAMA_CLOUD_API_KEY", reason: "LlamaParse", optional: true }]),
    ).toEqual([{ name: "LLAMA_CLOUD_API_KEY", optional: true, reason: "LlamaParse" }]);
  });

  test("object form defaults optional to false and reason to ''", () => {
    expect(normalizeDeclaredSecrets([{ name: "TOKEN" }])).toEqual([
      { name: "TOKEN", optional: false, reason: "" },
    ]);
  });

  test("mixed forms preserve order", () => {
    expect(
      normalizeDeclaredSecrets(["A", { name: "B", optional: true }, "C"]).map((d) => d.name),
    ).toEqual(["A", "B", "C"]);
  });

  test("malformed entry (no string name) throws a value-free error", () => {
    // @ts-expect-error — deliberately malformed to prove the guard fires.
    expect(() => normalizeDeclaredSecrets([{ reason: "no name" }])).toThrow(/invalid secret declaration/);
  });

  test("bare empty-string NAME is rejected (lockstep with validate)", () => {
    expect(() => normalizeDeclaredSecrets([""])).toThrow(/invalid secret declaration/);
  });

  test("object form with empty-string name is rejected", () => {
    expect(() => normalizeDeclaredSecrets([{ name: "" }])).toThrow(/invalid secret declaration/);
  });
});
