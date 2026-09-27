/**
 * Tests for `arc nats enable-jetstream` (arc#384).
 *
 * `arc nats add-account` mints accounts without JetStream limits, so a cortex
 * daemon landing in its per-stack agents account cannot create its streams.
 * `enable-jetstream` grants unlimited mem/disk storage, idempotently, and
 * verifies the grant by reading the account JWT back.
 *
 * All nsc invocations are stubbed via `__setNscRunnerForTests` — no real nsc
 * operator is needed and nothing is written to the live keystore.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  enableJetStream,
  accountJwtHasJetStream,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { ArcNatsCommandError } from "../../src/lib/json-response.js";

const ACCT = "ALICE_WORK_AGENTS";
const ACCT_PUBKEY = "AAFAKEACCOUNTPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function ok(stdout = ""): NscResult { return { exitCode: 0, stdout, stderr: "" }; }
function fail(stderr = "boom"): NscResult { return { exitCode: 1, stdout: "", stderr }; }

/** An unsigned account JWT whose claims carry `nats.limits` (placeholder signature). */
function accountJwt(limits: Record<string, unknown> | undefined): string {
  const claims = { sub: ACCT_PUBKEY, nats: limits === undefined ? { type: "account" } : { type: "account", limits } };
  const encoded = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.${encoded}.sig`;
}
const JWT_NO_JS = accountJwt({ subs: -1, conn: -1 });
const JWT_JS = accountJwt({ subs: -1, conn: -1, mem_storage: -1, disk_storage: -1 });

/**
 * A fake nsc store holding one account. `describe --raw` returns its current
 * JWT; `edit account` with the JetStream flags swaps in the enabled JWT unless
 * `editTakes` is false. Every argv is recorded.
 */
function fakeStore(opts: { jwt: string; editTakes?: boolean; exists?: boolean }): { runner: NscRunner; calls: string[][] } {
  const calls: string[][] = [];
  let jwt = opts.jwt;
  const runner: NscRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "describe" && args[1] === "account") {
      if (opts.exists === false) return fail("account not found");
      return args.includes("--raw") ? ok(`${jwt}\n`) : ok(JSON.stringify(ACCT_PUBKEY));
    }
    if (args[0] === "edit" && args[1] === "account") {
      if (opts.editTakes !== false) jwt = JWT_JS;
      return ok();
    }
    throw new Error(`Test runner: no handler for nsc ${args.join(" ")}`);
  };
  return { runner, calls };
}

beforeEach(() => {
  __setNscInstallCheckForTests(() => true);
});

afterEach(() => {
  __setNscRunnerForTests(null);
  __setNscInstallCheckForTests(null);
});

describe("accountJwtHasJetStream", () => {
  test("no limits object → disabled", () => {
    expect(accountJwtHasJetStream(accountJwt(undefined))).toBe(false);
  });
  test("limits without storage → disabled", () => {
    expect(accountJwtHasJetStream(JWT_NO_JS)).toBe(false);
  });
  test("unlimited (-1) storage → enabled", () => {
    expect(accountJwtHasJetStream(JWT_JS)).toBe(true);
  });
  test("a positive byte cap on one storage kind → enabled", () => {
    expect(accountJwtHasJetStream(accountJwt({ mem_storage: 0, disk_storage: 1073741824 }))).toBe(true);
  });
  test("a tier with non-zero storage → enabled; an all-zero tier → disabled", () => {
    expect(accountJwtHasJetStream(accountJwt({ tiered_limits: { R1: { disk_storage: -1 } } }))).toBe(true);
    expect(accountJwtHasJetStream(accountJwt({ tiered_limits: { R1: { mem_storage: 0, disk_storage: 0 } } }))).toBe(false);
  });
  test("not a JWT → null", () => {
    expect(accountJwtHasJetStream("not-a-jwt")).toBeNull();
  });
});

describe("enableJetStream — grant when absent", () => {
  test("runs nsc edit account with unlimited mem + disk storage, then verifies", () => {
    const { runner, calls } = fakeStore({ jwt: JWT_NO_JS });
    __setNscRunnerForTests(runner);

    const r = enableJetStream(ACCT, { json: true });

    expect(r).toEqual({ account: ACCT, pubKey: ACCT_PUBKEY, changed: true });
    const edits = calls.filter((c) => c[0] === "edit");
    expect(edits).toEqual([["edit", "account", "-n", ACCT, "--js-mem-storage", "-1", "--js-disk-storage", "-1"]]);
    // The JWT is read before AND after the edit (verify by read-back).
    const editAt = calls.findIndex((c) => c[0] === "edit");
    expect(calls.slice(editAt + 1).some((c) => c.includes("--raw"))).toBe(true);
  });
});

describe("enableJetStream — idempotent", () => {
  test("no edit when the account already carries JetStream limits", () => {
    const { runner, calls } = fakeStore({ jwt: JWT_JS });
    __setNscRunnerForTests(runner);

    const r = enableJetStream(ACCT, { json: true });

    expect(r.changed).toBe(false);
    expect(calls.some((c) => c[0] === "edit")).toBe(false);
  });

  test("hand-set positive limits are never overwritten", () => {
    const { runner, calls } = fakeStore({ jwt: accountJwt({ mem_storage: 0, disk_storage: 1073741824 }) });
    __setNscRunnerForTests(runner);

    expect(enableJetStream(ACCT, { json: true }).changed).toBe(false);
    expect(calls.some((c) => c[0] === "edit")).toBe(false);
  });
});

describe("enableJetStream — failures", () => {
  test("NSC_COMMAND_FAILED when the grant does not show up on read-back", () => {
    const { runner } = fakeStore({ jwt: JWT_NO_JS, editTakes: false });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      enableJetStream(ACCT, { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
    expect((err as ArcNatsCommandError).message).toContain("still has no JetStream limits");
  });

  test("ACCOUNT_NOT_FOUND when the account does not exist (no edit attempted)", () => {
    const { runner, calls } = fakeStore({ jwt: JWT_NO_JS, exists: false });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      enableJetStream("ALICE_NOPE", { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("ACCOUNT_NOT_FOUND");
    expect(calls.some((c) => c[0] === "edit")).toBe(false);
  });

  test("NSC_COMMAND_FAILED when describe --raw does not return a decodable JWT", () => {
    __setNscRunnerForTests((args) =>
      args.includes("--raw") ? ok("not-a-jwt") : ok(JSON.stringify(ACCT_PUBKEY)),
    );

    let err: unknown;
    try {
      enableJetStream(ACCT, { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });

  test("account-name validation rejects flag-injection before any nsc call", () => {
    const { runner, calls } = fakeStore({ jwt: JWT_NO_JS });
    __setNscRunnerForTests(runner);
    expect(() => enableJetStream("--all", { json: true })).toThrow(ArcNatsCommandError);
    expect(calls).toEqual([]);
  });
});
