/**
 * Unit tests for the server-side revocation path added in arc#130.
 *
 * These tests stub the nsc runner so they run without a configured nsc
 * environment. They assert call ORDER (revoke + push BEFORE delete), and
 * that push failure aborts the operation without deleting locally.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  removeBot,
  reissueBot,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const TEST_ACCOUNT = "OP_TEST";
const TEST_BOT = "arc-revoke-test-bot";
// Redirect creds writes to an isolated tmp dir so unit tests never touch the
// operator's real ~/.config/nats. Each suite gets its own dir.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "arc-a130-"));
const CUSTOM_OUT = join(TMP_ROOT, `${TEST_BOT}.creds`);

// JWT body sample — only `sub` matters for getUserPubKey.
const FAKE_USER_PUBKEY = "UAFAKEPUBKEYFORARCUNITTESTUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU";
const FAKE_USER_JWT_JSON = JSON.stringify({
  jti: "fake",
  iat: 0,
  iss: "AACCOUNT",
  sub: FAKE_USER_PUBKEY,
  name: TEST_BOT,
  nats: { type: "user" },
});

interface Call {
  args: string[];
}

function ok(stdout = ""): NscResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): NscResult {
  return { exitCode: 1, stdout: "", stderr };
}

/**
 * Build a runner that dispatches on the first arg + sub-arg to a handler map.
 * Records every call in `calls` (in invocation order) for ordering assertions.
 */
function keyFor(args: string[]): string {
  // Handlers are keyed by "<cmd>" or "<cmd> <subcmd>". A subcommand is the
  // second token only when it is not a flag (does not start with `-`).
  // Example: `push -a OP` → "push"; `revocations add-user -a OP -u UX` →
  // "revocations add-user"; `delete user -a OP -n n` → "delete user".
  const first = args[0] ?? "";
  const second = args[1];
  if (second && !second.startsWith("-")) return `${first} ${second}`;
  return first;
}

function buildRunner(handlers: Record<string, (args: string[]) => NscResult>): { runner: NscRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: NscRunner = (args) => {
    calls.push({ args: [...args] });
    const key = keyFor(args);
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`Test runner has no handler for: nsc ${args.join(" ")}`);
    }
    return handler(args);
  };
  return { runner, calls };
}

function cleanupOutPath(): void {
  try { unlinkSync(CUSTOM_OUT); } catch { /* ignore — path may not exist */ }
  try { unlinkSync(`${CUSTOM_OUT}.bak`); } catch { /* ignore — path may not exist */ }
}

beforeEach(() => {
  __setNscInstallCheckForTests(() => true);
});

afterEach(() => {
  __setNscRunnerForTests(null);
  __setNscInstallCheckForTests(null);
  cleanupOutPath();
});

describe("removeBot — server-side revocation", () => {
  test("invokes revocations add-user + push BEFORE delete user", () => {
    const { runner, calls } = buildRunner({
      "describe user": (args) => {
        // First call (userExists check) — no -J, return non-JSON success.
        // Second call (getUserPubKey) — with -J, return JSON.
        if (args.includes("-J")) return ok(FAKE_USER_JWT_JSON);
        return ok("user exists (text describe)");
      },
      "revocations add-user": () => ok("revoked"),
      "push": () => ok("pushed"),
      "delete user": () => ok("deleted"),
    });
    __setNscRunnerForTests(runner);

    removeBot(TEST_BOT, { account: TEST_ACCOUNT });

    // Assert ORDER: revocations add-user → push → delete user.
    const cmdSequence = calls.map((c) => keyFor(c.args));
    const revokeIdx = cmdSequence.indexOf("revocations add-user");
    const pushIdx = cmdSequence.indexOf("push");
    const deleteIdx = cmdSequence.indexOf("delete user");

    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(revokeIdx).toBeLessThan(pushIdx);
    expect(pushIdx).toBeLessThan(deleteIdx);

    // Revocation must reference the pubkey we surfaced via describe -J.
    const revokeCall = calls.find((c) => c.args[0] === "revocations" && c.args[1] === "add-user")!;
    expect(revokeCall.args).toContain("-u");
    expect(revokeCall.args).toContain(FAKE_USER_PUBKEY);
    expect(revokeCall.args).toContain(TEST_ACCOUNT);

    // Push must be scoped to the account.
    const pushCall = calls.find((c) => c.args[0] === "push")!;
    expect(pushCall.args).toEqual(["push", "-a", TEST_ACCOUNT]);
  });

  test("aborts and does NOT call delete user when push fails", () => {
    const { runner, calls } = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked locally"),
      "push": () => fail("connection refused: nats://localhost:4222"),
      "delete user": () => ok("should-not-be-called"),
    });
    __setNscRunnerForTests(runner);

    const exitSpy = mock(() => { throw new Error("process.exit called"); });
    const errSpy = mock(() => undefined);
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = exitSpy as unknown as typeof process.exit;
    console.error = errSpy;

    try {
      expect(() => removeBot(TEST_BOT, { account: TEST_ACCOUNT })).toThrow("process.exit called");
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    // Critical: delete user MUST NOT have been called.
    const deleteCalled = calls.some((c) => c.args[0] === "delete" && c.args[1] === "user");
    expect(deleteCalled).toBe(false);

    // Exit code must be non-zero.
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Operator must see the loud warning about the still-valid JWT.
    const errMessages = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errMessages).toContain("Server-side revoke failed");
    expect(errMessages).toContain("STILL VALID");
  });

  test("aborts when revocations add-user fails (before push, before delete)", () => {
    const { runner, calls } = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => fail("permission denied: account signing key required"),
      "push": () => ok("should-not-be-called"),
      "delete user": () => ok("should-not-be-called"),
    });
    __setNscRunnerForTests(runner);

    const exitSpy = mock(() => { throw new Error("process.exit called"); });
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = exitSpy as unknown as typeof process.exit;
    console.error = mock(() => undefined);

    try {
      expect(() => removeBot(TEST_BOT, { account: TEST_ACCOUNT })).toThrow("process.exit called");
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
    expect(calls.some((c) => c.args[0] === "delete" && c.args[1] === "user")).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("reissueBot — server-side revocation of OLD pubkey", () => {
  test("revokes old pubkey + push BEFORE delete + add", () => {
    // reissueBot calls writeCredsFile to a path; we redirect via --output so
    // the unit test does not touch the operator's real creds dir.
    const outDir = dirname(CUSTOM_OUT);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
    // Seed an existing creds file so the backup branch fires (exercises the
    // full path, not just the no-backup variant).
    writeFileSync(CUSTOM_OUT, "OLD CREDS CONTENT", { mode: 0o600 });

    const { runner, calls } = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked"),
      "push": () => ok("pushed"),
      "delete user": () => ok("deleted"),
      "add user": () => ok("added"),
      "generate creds": () => ok("-----BEGIN NATS USER JWT-----\nfake\n-----END NATS USER JWT-----\n-----BEGIN USER NKEY SEED-----\nSUFAKE\n-----END USER NKEY SEED-----"),
    });
    __setNscRunnerForTests(runner);

    reissueBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT });

    const cmdSequence = calls.map((c) => keyFor(c.args));
    const revokeIdx = cmdSequence.indexOf("revocations add-user");
    const pushIdx = cmdSequence.indexOf("push");
    const deleteIdx = cmdSequence.indexOf("delete user");
    const addIdx = cmdSequence.indexOf("add user");

    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(revokeIdx).toBeLessThan(pushIdx);
    expect(pushIdx).toBeLessThan(deleteIdx);
    expect(deleteIdx).toBeLessThan(addIdx);

    // Revocation targets the OLD user's pubkey (captured via describe -J
    // BEFORE delete).
    const revokeCall = calls.find((c) => c.args[0] === "revocations" && c.args[1] === "add-user")!;
    expect(revokeCall.args).toContain(FAKE_USER_PUBKEY);
  });

  test("aborts and does NOT delete+add when push fails", () => {
    const outDir = dirname(CUSTOM_OUT);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(CUSTOM_OUT, "OLD CREDS CONTENT", { mode: 0o600 });

    const { runner, calls } = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked locally"),
      "push": () => fail("nats: timeout waiting for ACK"),
      "delete user": () => ok("should-not-be-called"),
      "add user": () => ok("should-not-be-called"),
      "generate creds": () => ok("should-not-be-called"),
    });
    __setNscRunnerForTests(runner);

    const exitSpy = mock(() => { throw new Error("process.exit called"); });
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = exitSpy as unknown as typeof process.exit;
    console.error = mock(() => undefined);

    try {
      expect(() => reissueBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT })).toThrow("process.exit called");
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    expect(calls.some((c) => c.args[0] === "delete" && c.args[1] === "user")).toBe(false);
    expect(calls.some((c) => c.args[0] === "add" && c.args[1] === "user")).toBe(false);
    expect(calls.some((c) => c.args[0] === "generate")).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("getUserPubKey — error surface", () => {
  test("removeBot fails cleanly when describe -J returns malformed JSON", () => {
    const { runner } = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok("not-json{{{") : ok("exists"),
      "revocations add-user": () => ok("should-not-be-called"),
      "push": () => ok("should-not-be-called"),
      "delete user": () => ok("should-not-be-called"),
    });
    __setNscRunnerForTests(runner);

    const exitSpy = mock(() => { throw new Error("process.exit called"); });
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = exitSpy as unknown as typeof process.exit;
    console.error = mock(() => undefined);

    try {
      expect(() => removeBot(TEST_BOT, { account: TEST_ACCOUNT })).toThrow("process.exit called");
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("removeBot fails cleanly when 'sub' is missing or not a U-prefixed nkey", () => {
    const { runner } = buildRunner({
      "describe user": (args) =>
        args.includes("-J")
          ? ok(JSON.stringify({ jti: "x", sub: "A_NOT_A_USER_NKEY" }))
          : ok("exists"),
      "revocations add-user": () => ok("should-not-be-called"),
      "push": () => ok("should-not-be-called"),
      "delete user": () => ok("should-not-be-called"),
    });
    __setNscRunnerForTests(runner);

    const exitSpy = mock(() => { throw new Error("process.exit called"); });
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = exitSpy as unknown as typeof process.exit;
    console.error = mock(() => undefined);

    try {
      expect(() => removeBot(TEST_BOT, { account: TEST_ACCOUNT })).toThrow("process.exit called");
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
