/**
 * Tests for `arc nats add-federated-user` (cortex#1598, design §5.3/§5.4).
 *
 * The scoped hub-transport user mint: ONE `federated`-role scoped signing key
 * per account carries the subject-templated permission set; every minted user
 * is signed by it and carries no permissions of its own. All nsc invocations
 * are stubbed via `__setNscRunnerForTests` — nothing touches a live keystore.
 *
 * Coverage:
 *   - fresh mint: scoped key created ONCE with the hardwired templates, user
 *     added with -K <scoped key> and NO permission flags, creds written 0600
 *   - idempotent re-run: no signing-key edit, no add user; creds re-exported;
 *     scopeAlreadyPresent + userAlreadyPresent
 *   - refusal: an existing user signed by a DIFFERENT key → USER_NOT_SCOPED,
 *     no creds written (re-exporting it would hand out an unscoped credential)
 *   - refusal: a scope-signed user that somehow carries own perms → USER_NOT_SCOPED
 *   - scoped-key discovery tolerates both nsc JSON shapes (array + map)
 *   - name validation (<principal>.<stack> dotted grammar, flag injection)
 *   - ACCOUNT_NOT_FOUND / SIGNING_KEY_FAILED propagation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  addFederatedUser,
  FEDERATED_SUB_TEMPLATE,
  FEDERATED_PUB_TEMPLATE,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { ArcNatsCommandError } from "../../src/lib/json-response.js";
import { mkdtempSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Fixtures (clearly-fake key material) ─────────────────────────────────────

const ACCT = "FEDERATION";
const ACCT_PUBKEY = "AAFAKEACCOUNTPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SK_PUBKEY = "AAFAKESCOPEDSIGNINGKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OTHER_KEY = "AAFAKEOTHERISSUERKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const USER_PUBKEY = "UAFAKEUSERPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const USER = "jc.default";

const FAKE_CREDS =
  "-----BEGIN NATS USER JWT-----\n" + "A".repeat(64) + "\n------END NATS USER JWT------\n\n" +
  "-----BEGIN USER NKEY SEED-----\nSUA" + "A".repeat(55) + "\n------END USER NKEY SEED------\n";

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
    const k = keyFor(args);
    const handler = handlers[k];
    if (!handler) throw new Error(`Test runner: no handler for nsc ${args.join(" ")}`);
    return handler(args);
  };
}

/** The LIVE template shape a well-formed federated scope carries. */
const GOOD_TEMPLATE = {
  sub: { allow: [`federated.{{name()}}.>`, `_INBOX.>`] },
  pub: { allow: [`federated.>`, `_INBOX.>`] },
};
/** A hand-edited / divergent scope (wider sub than the hardwired template). */
const DIVERGENT_TEMPLATE = {
  sub: { allow: [`federated.>`] },
  pub: { allow: [`federated.>`, `_INBOX.>`] },
};

/** Account claims JSON with signing_keys in the ARRAY-of-objects shape. */
function accountJsonArray(withScope: boolean, template: object = GOOD_TEMPLATE): NscResult {
  return ok(JSON.stringify({
    sub: ACCT_PUBKEY,
    nats: {
      signing_keys: withScope
        ? [{ key: SK_PUBKEY, role: "federated", template }]
        : [],
    },
  }));
}

/** Account claims JSON with signing_keys in the MAP-keyed-by-pubkey shape. */
function accountJsonMap(withScope: boolean, template: object = GOOD_TEMPLATE): NscResult {
  return ok(JSON.stringify({
    sub: ACCT_PUBKEY,
    nats: {
      signing_keys: withScope
        ? { [SK_PUBKEY]: { kind: "user_scope", role: "federated", template } }
        : {},
    },
  }));
}

function userClaims(iss: string, ownPerms = false): NscResult {
  return ok(JSON.stringify({
    iss,
    sub: USER_PUBKEY,
    nats: ownPerms ? { pub: { allow: ["federated.>"] }, sub: {} } : {},
  }));
}

/**
 * A configurable happy-path runner. State toggles let each test start from a
 * different store shape and observe exactly which nsc mutations ran.
 */
function fakeStore(opts: {
  scopeExists?: boolean;
  userExists?: boolean;
  userIss?: string;
  userOwnPerms?: boolean;
  mapShape?: boolean;
}) {
  const state = {
    scopeExists: opts.scopeExists ?? false,
    userExists: opts.userExists ?? false,
    userIss: opts.userIss ?? SK_PUBKEY,
    userOwnPerms: opts.userOwnPerms ?? false,
    calls: [] as string[],
  };
  const accountJson = (withScope: boolean) =>
    (opts.mapShape === true ? accountJsonMap(withScope) : accountJsonArray(withScope));

  const runner = buildRunner({
    "describe account": (args) => {
      state.calls.push(`describe account${args.includes("-F") ? " -F" : " -J"}`);
      if (args.includes("-F")) return subField(ACCT_PUBKEY);
      return accountJson(state.scopeExists);
    },
    "edit signing-key": (args) => {
      state.calls.push(`edit signing-key ${args.join(" ")}`);
      state.scopeExists = true;
      return ok("[ OK ] edited signing key");
    },
    "describe user": (args) => {
      state.calls.push(`describe user${args.includes("-J") ? " -J" : ""}`);
      if (!state.userExists) return fail("user not found");
      return args.includes("-J") ? userClaims(state.userIss, state.userOwnPerms) : ok("user");
    },
    "add user": (args) => {
      state.calls.push(`add user ${args.join(" ")}`);
      state.userExists = true;
      return ok(`[ OK ] added user "${USER}"`);
    },
    "generate creds": () => {
      state.calls.push("generate creds");
      return ok(FAKE_CREDS);
    },
  });
  return { state, runner };
}

let tmp: string;

beforeEach(() => {
  __setNscInstallCheckForTests(() => true);
  tmp = mkdtempSync(join(tmpdir(), "arc-fed-user-"));
});

afterEach(() => {
  __setNscRunnerForTests(null);
  __setNscInstallCheckForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fresh mint ────────────────────────────────────────────────────────────────

describe("addFederatedUser — fresh mint", () => {
  test("creates the scoped key with hardwired templates, mints the user with -K, exports 0600 creds", () => {
    const { state, runner } = fakeStore({});
    __setNscRunnerForTests(runner);
    const out = join(tmp, "jc.default.creds");

    const r = addFederatedUser(USER, { account: ACCT, output: out, json: true });

    // Scoped key: created once, with EXACTLY the hardwired templates.
    const skCall = state.calls.find((c) => c.startsWith("edit signing-key"));
    expect(skCall).toBeDefined();
    expect(skCall).toContain(`--role federated`);
    expect(skCall).toContain(`--allow-sub ${FEDERATED_SUB_TEMPLATE}`);
    expect(skCall).toContain(`--allow-pub ${FEDERATED_PUB_TEMPLATE}`);

    // User: added signed by the scoped key, with NO permission flags.
    const addCall = state.calls.find((c) => c.startsWith("add user"));
    expect(addCall).toBeDefined();
    expect(addCall).toContain(`-K ${SK_PUBKEY}`);
    expect(addCall).not.toContain("--allow-pub");
    expect(addCall).not.toContain("--allow-sub");
    // And no `edit user` permission calls at all.
    expect(state.calls.some((c) => c.startsWith("edit user"))).toBe(false);

    // Creds on disk, 0600, verbatim.
    expect(readFileSync(out, "utf-8")).toBe(FAKE_CREDS.trim());
    expect(statSync(out).mode & 0o777).toBe(0o600);

    // Result shape.
    expect(r.scopeCreated).toBe(true);
    expect(r.scopeAlreadyPresent).toBe(false);
    expect(r.userCreated).toBe(true);
    expect(r.userAlreadyPresent).toBe(false);
    expect(r.signingKeyPubKey).toBe(SK_PUBKEY);
    expect(r.userPubKey).toBe(USER_PUBKEY);
    expect(r.accountPubKey).toBe(ACCT_PUBKEY);
    expect(r.subTemplate).toBe(FEDERATED_SUB_TEMPLATE);
    expect(r.pubTemplate).toBe(FEDERATED_PUB_TEMPLATE);
    expect(r.jwt).toBe("A".repeat(64));
  });

  test("scoped-key discovery tolerates the MAP signing_keys shape", () => {
    const { state, runner } = fakeStore({ scopeExists: true, mapShape: true });
    __setNscRunnerForTests(runner);

    const r = addFederatedUser(USER, { account: ACCT, output: join(tmp, "u.creds"), json: true });

    expect(r.scopeAlreadyPresent).toBe(true);
    expect(r.signingKeyPubKey).toBe(SK_PUBKEY);
    expect(state.calls.some((c) => c.startsWith("edit signing-key"))).toBe(false);
  });
});

// ── Idempotency (§5.4) ────────────────────────────────────────────────────────

describe("addFederatedUser — idempotent re-run", () => {
  test("existing scope + existing scope-signed user → no mutations, creds re-exported", () => {
    const { state, runner } = fakeStore({ scopeExists: true, userExists: true });
    __setNscRunnerForTests(runner);
    const out = join(tmp, "again.creds");

    const r = addFederatedUser(USER, { account: ACCT, output: out, json: true });

    expect(state.calls.some((c) => c.startsWith("edit signing-key"))).toBe(false);
    expect(state.calls.some((c) => c.startsWith("add user"))).toBe(false);
    expect(state.calls).toContain("generate creds");
    expect(readFileSync(out, "utf-8")).toBe(FAKE_CREDS.trim());
    expect(r.scopeAlreadyPresent).toBe(true);
    expect(r.userAlreadyPresent).toBe(true);
    expect(r.scopeCreated).toBe(false);
    expect(r.userCreated).toBe(false);
  });
});

// ── Refusals (unscoped export is structurally impossible) ────────────────────

describe("addFederatedUser — refuses an unscoped export", () => {
  test("existing user signed by a DIFFERENT key → USER_NOT_SCOPED, no creds written", () => {
    const { state, runner } = fakeStore({ scopeExists: true, userExists: true, userIss: OTHER_KEY });
    __setNscRunnerForTests(runner);
    const out = join(tmp, "foreign.creds");

    expect(() => addFederatedUser(USER, { account: ACCT, output: out, json: true }))
      .toThrow(ArcNatsCommandError);
    try {
      addFederatedUser(USER, { account: ACCT, output: out, json: true });
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("USER_NOT_SCOPED");
    }
    expect(state.calls).not.toContain("generate creds");
    expect(() => statSync(out)).toThrow();
  });

  test("scope-signed user carrying its OWN permissions → USER_NOT_SCOPED", () => {
    const { runner } = fakeStore({ scopeExists: true, userExists: true, userOwnPerms: true });
    __setNscRunnerForTests(runner);

    try {
      addFederatedUser(USER, { account: ACCT, output: join(tmp, "p.creds"), json: true });
      throw new Error("expected USER_NOT_SCOPED");
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("USER_NOT_SCOPED");
    }
  });
});

// ── Validation + error propagation ────────────────────────────────────────────

describe("addFederatedUser — validation", () => {
  test.each(["Bad.name", "jc", "jc/default", "--force", "jc.", ".default", "jc..default"])(
    "rejects malformed name %s",
    (bad) => {
      __setNscRunnerForTests(buildRunner({}));
      try {
        addFederatedUser(bad, { account: ACCT, json: true });
        throw new Error("expected VALIDATION_ERROR");
      } catch (err) {
        expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
      }
    },
  );

  test("missing account → ACCOUNT_NOT_FOUND", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": () => fail("account not found"),
    }));
    try {
      addFederatedUser(USER, { account: ACCT, json: true });
      throw new Error("expected ACCOUNT_NOT_FOUND");
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  test("pre-existing federated scope with DIVERGENT templates → SIGNING_KEY_FAILED, no mint", () => {
    const calls: string[] = [];
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) =>
        (args.includes("-F") ? subField(ACCT_PUBKEY) : accountJsonArray(true, DIVERGENT_TEMPLATE)),
      "add user": (args) => { calls.push(`add user ${args.join(" ")}`); return ok(); },
    }));
    try {
      addFederatedUser(USER, { account: ACCT, output: join(tmp, "d.creds"), json: true });
      throw new Error("expected SIGNING_KEY_FAILED");
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("SIGNING_KEY_FAILED");
      expect((err as ArcNatsCommandError).message).toContain("DIVERGES");
    }
    // Nothing was minted under the divergent scope.
    expect(calls).toEqual([]);
  });

  test("signing-key creation failure → SIGNING_KEY_FAILED", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) => (args.includes("-F") ? subField(ACCT_PUBKEY) : accountJsonArray(false)),
      "edit signing-key": () => fail("cannot edit"),
    }));
    try {
      addFederatedUser(USER, { account: ACCT, json: true });
      throw new Error("expected SIGNING_KEY_FAILED");
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("SIGNING_KEY_FAILED");
    }
  });

  test("scope reported created but not visible on re-describe → SIGNING_KEY_FAILED (refuse unverified scope)", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) => (args.includes("-F") ? subField(ACCT_PUBKEY) : accountJsonArray(false)),
      "edit signing-key": () => ok("[ OK ]"),
    }));
    try {
      addFederatedUser(USER, { account: ACCT, json: true });
      throw new Error("expected SIGNING_KEY_FAILED");
    } catch (err) {
      expect((err as ArcNatsCommandError).code).toBe("SIGNING_KEY_FAILED");
    }
  });
});
