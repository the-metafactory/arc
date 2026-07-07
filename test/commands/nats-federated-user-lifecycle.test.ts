/**
 * Tests for `arc nats reissue-federated-user` (rotate) and
 * `revoke-federated-user` (cortex#1599, design §2 seam 4).
 *
 * Both cut the OLD key server-side via `revocations add-user` + `nsc push` — a
 * runtime revoke (no hub restart). The load-bearing invariants:
 *   - the revoke+push MUST land BEFORE any local delete (a half-done revoke
 *     leaves a still-valid JWT on the bus), so a push failure aborts with the
 *     user still present,
 *   - reissue re-mints FRESH material under the SAME scoped signing key (no own
 *     perms) and refuses an unscoped export,
 *   - all nsc invocations are stubbed — nothing touches a live keystore.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  reissueFederatedUser,
  revokeFederatedUser,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { ArcNatsCommandError } from "../../src/lib/json-response.js";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ACCT = "FEDERATION";
const ACCT_PUBKEY = "AAFAKEACCOUNTPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SK_PUBKEY = "AAFAKESCOPEDSIGNINGKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OTHER_KEY = "AAFAKEOTHERISSUERKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const USER_PUBKEY = "UAFAKEUSERPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const USER = "jc.default";

const FAKE_CREDS =
  "-----BEGIN NATS USER JWT-----\n" + "A".repeat(64) + "\n------END NATS USER JWT------\n\n" +
  "-----BEGIN USER NKEY SEED-----\nSUA" + "A".repeat(55) + "\n------END USER NKEY SEED------\n";

const GOOD_TEMPLATE = {
  sub: { allow: [`federated.{{name()}}.>`, `_INBOX.>`] },
  pub: { allow: [`federated.>`, `_INBOX.>`] },
};

function ok(stdout = ""): NscResult { return { exitCode: 0, stdout, stderr: "" }; }
function fail(stderr = "boom"): NscResult { return { exitCode: 1, stdout: "", stderr }; }
function subField(pubkey: string): NscResult { return ok(JSON.stringify(pubkey)); }

function keyFor(args: string[]): string {
  const verb = args[0] ?? "";
  const noun = args[1];
  if (noun && !noun.startsWith("-")) return `${verb} ${noun}`;
  return verb;
}
function buildRunner(handlers: Record<string, (args: string[]) => NscResult>): NscRunner {
  return (args) => {
    const h = handlers[keyFor(args)];
    if (!h) throw new Error(`Test runner: no handler for nsc ${args.join(" ")}`);
    return h(args);
  };
}

function accountJson(): NscResult {
  return ok(JSON.stringify({ sub: ACCT_PUBKEY, nats: { signing_keys: [{ key: SK_PUBKEY, role: "federated", template: GOOD_TEMPLATE }] } }));
}
function userClaims(iss: string, ownPerms = false): NscResult {
  return ok(JSON.stringify({ iss, sub: USER_PUBKEY, nats: ownPerms ? { pub: { allow: ["federated.>"] }, sub: {} } : {} }));
}

/**
 * Full-lifecycle fake store: account with the scope, a present user, and
 * handlers for revocations / push / delete. `pushFails` aborts the push;
 * `newUserIss` is what the RE-MINTED user reports (default: scoped, valid).
 */
function fakeStore(opts: { userExists?: boolean; pushFails?: boolean; newUserIss?: string } = {}) {
  const state = {
    userExists: opts.userExists ?? true,
    newUserIss: opts.newUserIss ?? SK_PUBKEY,
    calls: [] as string[],
  };
  const runner = buildRunner({
    "describe account": (args) => (args.includes("-F") ? subField(ACCT_PUBKEY) : accountJson()),
    "describe user": (args) => {
      if (!state.userExists) return fail("user not found");
      // -J → claims (getUserPubKey reads .sub; describeUserClaims reads .iss).
      return args.includes("-J") ? userClaims(state.newUserIss) : ok("user");
    },
    "revocations add-user": (args) => { state.calls.push(`revocations add-user ${args.join(" ")}`); return ok("[ OK ] added revocation"); },
    "push": () => {
      state.calls.push("push");
      if (opts.pushFails === true) return fail("connection refused");
      return ok("[ OK ] pushed");
    },
    "delete user": () => { state.calls.push("delete user"); state.userExists = false; return ok("[ OK ] deleted"); },
    "add user": (args) => { state.calls.push(`add user ${args.join(" ")}`); state.userExists = true; return ok("[ OK ] added"); },
    "generate creds": () => { state.calls.push("generate creds"); return ok(FAKE_CREDS); },
  });
  return { state, runner };
}

let tmp: string;
beforeEach(() => { __setNscInstallCheckForTests(() => true); tmp = mkdtempSync(join(tmpdir(), "arc-fed-lifecycle-")); });
afterEach(() => { __setNscRunnerForTests(null); __setNscInstallCheckForTests(null); rmSync(tmp, { recursive: true, force: true }); });

// ── revoke ──────────────────────────────────────────────────────────────────

describe("revokeFederatedUser", () => {
  test("revokes + pushes, THEN deletes; returns the revoked pubkey", () => {
    const { state, runner } = fakeStore();
    __setNscRunnerForTests(runner);
    const r = revokeFederatedUser(USER, { account: ACCT, json: true });

    expect(r.revokedPubKey).toBe(USER_PUBKEY);
    // revocations add-user keyed by the user pubkey, then a push, then delete.
    const revIdx = state.calls.findIndex((c) => c.startsWith("revocations add-user"));
    const pushIdx = state.calls.indexOf("push");
    const delIdx = state.calls.findIndex((c) => c === "delete user");
    expect(revIdx).toBeGreaterThanOrEqual(0);
    expect(state.calls[revIdx]).toContain(USER_PUBKEY);
    expect(pushIdx).toBeGreaterThan(revIdx);
    expect(delIdx).toBeGreaterThan(pushIdx); // delete only AFTER a successful push
  });

  test("a push failure aborts with the user STILL PRESENT (no delete)", () => {
    const { state, runner } = fakeStore({ pushFails: true });
    __setNscRunnerForTests(runner);
    expect(() => revokeFederatedUser(USER, { account: ACCT, json: true })).toThrow(ArcNatsCommandError);
    expect(state.calls.some((c) => c === "delete user")).toBe(false);
  });

  test("USER_NOT_FOUND when the user is absent — nothing revoked", () => {
    const { state, runner } = fakeStore({ userExists: false });
    __setNscRunnerForTests(runner);
    try {
      revokeFederatedUser(USER, { account: ACCT, json: true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArcNatsCommandError);
      expect((err as ArcNatsCommandError).code).toBe("USER_NOT_FOUND");
    }
    expect(state.calls.some((c) => c.startsWith("revocations"))).toBe(false);
  });

  test("rejects a non-federated-user name (grammar / flag injection)", () => {
    __setNscRunnerForTests(fakeStore().runner);
    expect(() => revokeFederatedUser("Bad Name", { account: ACCT, json: true })).toThrow(ArcNatsCommandError);
  });
});

// ── reissue (rotate) ─────────────────────────────────────────────────────────

describe("reissueFederatedUser", () => {
  test("revokes old, re-mints under the scoped key, exports fresh creds", () => {
    const { state, runner } = fakeStore();
    __setNscRunnerForTests(runner);
    const out = join(tmp, "jc.default.creds");

    const r = reissueFederatedUser(USER, { account: ACCT, output: out, json: true });

    expect(r.revokedPubKey).toBe(USER_PUBKEY);
    expect(r.newPubKey).toBe(USER_PUBKEY);
    expect(r.signingKeyPubKey).toBe(SK_PUBKEY);
    expect(r.credsPath).toBe(out);
    expect(existsSync(out)).toBe(true);

    // Order: revoke + push BEFORE delete; re-add uses -K <scoped key>.
    const pushIdx = state.calls.indexOf("push");
    const delIdx = state.calls.findIndex((c) => c === "delete user");
    const addIdx = state.calls.findIndex((c) => c.startsWith("add user"));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(pushIdx);
    expect(addIdx).toBeGreaterThan(delIdx);
    expect(state.calls[addIdx]).toContain(`-K ${SK_PUBKEY}`);
  });

  test("a push failure during revoke aborts BEFORE delete (old creds still live)", () => {
    const { state, runner } = fakeStore({ pushFails: true });
    __setNscRunnerForTests(runner);
    expect(() => reissueFederatedUser(USER, { account: ACCT, output: join(tmp, "x.creds"), json: true })).toThrow(ArcNatsCommandError);
    expect(state.calls.some((c) => c === "delete user")).toBe(false);
  });

  test("refuses to export when the re-minted user is not scope-governed (USER_NOT_SCOPED)", () => {
    const { runner } = fakeStore({ newUserIss: OTHER_KEY });
    __setNscRunnerForTests(runner);
    const out = join(tmp, "jc.default.creds");
    try {
      reissueFederatedUser(USER, { account: ACCT, output: out, json: true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ArcNatsCommandError);
      expect((err as ArcNatsCommandError).code).toBe("USER_NOT_SCOPED");
    }
  });

  test("USER_NOT_FOUND when there is nothing to rotate", () => {
    __setNscRunnerForTests(fakeStore({ userExists: false }).runner);
    try {
      reissueFederatedUser(USER, { account: ACCT, json: true });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("USER_NOT_FOUND");
    }
  });
});
