import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  removeBot,
  reissueBot,
  __setNscRunner,
  type NscResult,
} from "../../src/commands/nats.js";

/**
 * Unit tests for #130: server-side NATS revocation must happen BEFORE the
 * local `nsc delete user`, and a push failure must abort the operation
 * without deleting the user.
 *
 * These tests inject a mock `nsc` runner so they don't require nsc or a
 * running NATS server.
 */

const ACCOUNT = "OP_TEST";
const BOT = "test-bot";
const FAKE_PUBKEY = "UAFAKEPUBKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

type RecordedCall = { args: string[] };

function recordingRunner(behavior: {
  fail?: (args: string[]) => string | null;
  describeOutput?: string;
}) {
  const calls: RecordedCall[] = [];
  const run = (args: string[]): NscResult => {
    calls.push({ args });
    const failMsg = behavior.fail?.(args);
    if (failMsg !== null && failMsg !== undefined) {
      return { exitCode: 1, stdout: "", stderr: failMsg };
    }
    // canned responses
    if (args[0] === "describe" && args[1] === "user") {
      return { exitCode: 0, stdout: behavior.describeOutput ?? FAKE_PUBKEY, stderr: "" };
    }
    if (args[0] === "generate" && args[1] === "creds") {
      return {
        exitCode: 0,
        stdout: "-----BEGIN NATS USER JWT-----\nx\n------END NATS USER JWT------\n-----BEGIN USER NKEY SEED-----\ny\n------END USER NKEY SEED------",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

function indexOfArgs(calls: RecordedCall[], match: (args: string[]) => boolean): number {
  return calls.findIndex((c) => match(c.args));
}

afterEach(() => {
  __setNscRunner(null);
});

describe("removeBot — server-side revocation (#130)", () => {
  test("invokes describe → revocations add-user → push → delete user, in order", () => {
    const { calls, run } = recordingRunner({});
    __setNscRunner(run);

    removeBot(BOT, { account: ACCOUNT });

    const idxDescribe = indexOfArgs(calls, (a) => a[0] === "describe" && a[1] === "user");
    const idxRevoke = indexOfArgs(calls, (a) => a[0] === "revocations" && a[1] === "add-user");
    const idxPush = indexOfArgs(calls, (a) => a[0] === "push");
    const idxDelete = indexOfArgs(calls, (a) => a[0] === "delete" && a[1] === "user");

    expect(idxDescribe).toBeGreaterThanOrEqual(0);
    expect(idxRevoke).toBeGreaterThanOrEqual(0);
    expect(idxPush).toBeGreaterThanOrEqual(0);
    expect(idxDelete).toBeGreaterThanOrEqual(0);

    // Strict ordering: describe < revoke < push < delete
    expect(idxDescribe).toBeLessThan(idxRevoke);
    expect(idxRevoke).toBeLessThan(idxPush);
    expect(idxPush).toBeLessThan(idxDelete);
  });

  test("passes the user's pubkey from describe to revocations add-user", () => {
    const { calls, run } = recordingRunner({ describeOutput: FAKE_PUBKEY });
    __setNscRunner(run);

    removeBot(BOT, { account: ACCOUNT });

    const revokeCall = calls.find((c) => c.args[0] === "revocations" && c.args[1] === "add-user");
    expect(revokeCall).toBeDefined();
    expect(revokeCall!.args).toContain("-u");
    const uIdx = revokeCall!.args.indexOf("-u");
    expect(revokeCall!.args[uIdx + 1]).toBe(FAKE_PUBKEY);
  });

  test("strips wrapping quotes from `nsc describe --field sub` output", () => {
    const { calls, run } = recordingRunner({ describeOutput: `"${FAKE_PUBKEY}"` });
    __setNscRunner(run);

    removeBot(BOT, { account: ACCOUNT });

    const revokeCall = calls.find((c) => c.args[0] === "revocations" && c.args[1] === "add-user");
    const uIdx = revokeCall!.args.indexOf("-u");
    expect(revokeCall!.args[uIdx + 1]).toBe(FAKE_PUBKEY);
  });

  test("aborts on `nsc push` failure WITHOUT calling delete user", () => {
    const { calls, run } = recordingRunner({
      fail: (args) => (args[0] === "push" ? "nats: server unreachable" : null),
    });
    __setNscRunner(run);

    expect(() => removeBot(BOT, { account: ACCOUNT })).toThrow(/Server-side revoke failed/);
    expect(() => removeBot(BOT, { account: ACCOUNT })).toThrow(/STILL VALID/);

    const deleteCall = calls.find((c) => c.args[0] === "delete" && c.args[1] === "user");
    expect(deleteCall).toBeUndefined();
  });

  test("aborts on pubkey-lookup failure with clear error", () => {
    const { calls, run } = recordingRunner({
      // Fail the *second* describe (the one with --field sub). The first describe
      // call comes from userExists() and must succeed so we reach revoke logic.
      fail: (() => {
        let seen = 0;
        return (args: string[]) => {
          if (args[0] === "describe" && args[1] === "user") {
            seen++;
            if (seen >= 2 && args.includes("--field")) return "user JWT not found";
          }
          return null;
        };
      })(),
    });
    __setNscRunner(run);

    expect(() => removeBot(BOT, { account: ACCOUNT })).toThrow(/server-side revoke skipped/);

    const deleteCall = calls.find((c) => c.args[0] === "delete" && c.args[1] === "user");
    expect(deleteCall).toBeUndefined();
  });

  test("revokes even when --delete-creds is false (local file unrelated to server revoke)", () => {
    const { calls, run } = recordingRunner({});
    __setNscRunner(run);

    removeBot(BOT, { account: ACCOUNT, deleteCreds: false });

    const revokeCall = calls.find((c) => c.args[0] === "revocations" && c.args[1] === "add-user");
    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(revokeCall).toBeDefined();
    expect(pushCall).toBeDefined();
  });
});

describe("reissueBot — server-side revocation of old creds (#130)", () => {
  let tmpDir: string;
  let credsPath: string;

  function setupTmpCreds() {
    tmpDir = mkdtempSync(join(tmpdir(), "arc-nats-revoke-"));
    credsPath = join(tmpDir, "test-bot.creds");
    writeFileSync(credsPath, "OLD_CREDS_CONTENT");
  }

  function cleanupTmp() {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }

  test("revokes + pushes BEFORE delete during rotation", () => {
    setupTmpCreds();
    try {
      const { calls, run } = recordingRunner({});
      __setNscRunner(run);

      reissueBot(BOT, { account: ACCOUNT, output: credsPath });

      const idxRevoke = indexOfArgs(calls, (a) => a[0] === "revocations" && a[1] === "add-user");
      const idxPush = indexOfArgs(calls, (a) => a[0] === "push");
      const idxDelete = indexOfArgs(calls, (a) => a[0] === "delete" && a[1] === "user");
      const idxAdd = indexOfArgs(calls, (a) => a[0] === "add" && a[1] === "user");

      expect(idxRevoke).toBeGreaterThanOrEqual(0);
      expect(idxPush).toBeGreaterThanOrEqual(0);
      expect(idxRevoke).toBeLessThan(idxPush);
      expect(idxPush).toBeLessThan(idxDelete);
      expect(idxDelete).toBeLessThan(idxAdd);
    } finally {
      cleanupTmp();
    }
  });

  test("aborts on push failure without deleting the old user", () => {
    setupTmpCreds();
    try {
      const { calls, run } = recordingRunner({
        fail: (args) => (args[0] === "push" ? "nats: server unreachable" : null),
      });
      __setNscRunner(run);

      expect(() => reissueBot(BOT, { account: ACCOUNT, output: credsPath })).toThrow(/Server-side revoke failed/);

      const deleteCall = calls.find((c) => c.args[0] === "delete" && c.args[1] === "user");
      expect(deleteCall).toBeUndefined();

      // Old creds file still intact on disk since we aborted before delete
      expect(existsSync(credsPath)).toBe(true);
    } finally {
      cleanupTmp();
    }
  });
});
