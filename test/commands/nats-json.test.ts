/**
 * Tests for the stable `--json` contract on `arc nats *` commands (arc#131).
 *
 * These cover the unit-level behavior of the command functions in JSON mode:
 *   - On success, the function returns a structured result whose shape matches
 *     the documented `arc.nats.v1` schema.
 *   - On failure, the function throws an `ArcNatsCommandError` with a code
 *     drawn from the documented closed set (see `src/lib/json-response.ts`).
 *
 * The CLI-layer JSON envelope (the `{schema, ok, ...}` wrapping) is asserted
 * by end-to-end runs of the compiled CLI (further down in this file). That
 * way both the function contract and the wire format are pinned.
 *
 * Tests stub `nsc` via `__setNscRunnerForTests` so they run without a real
 * nsc operator on the host.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  addBot,
  reissueBot,
  removeBot,
  setupOperator,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { ArcNatsCommandError, ARC_NATS_SCHEMA } from "../../src/lib/json-response.js";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";

const TEST_ACCOUNT = "OP_TEST_JSON";
const TEST_BOT = "arc-json-test-bot";
const TMP_ROOT = mkdtempSync(join(tmpdir(), "arc-a131-"));
const CUSTOM_OUT = join(TMP_ROOT, `${TEST_BOT}.creds`);

const FAKE_USER_PUBKEY = "UAFAKEPUBKEYFORARCUNITTESTUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU";
const NEW_USER_PUBKEY = "UANEWREPLACEMENTKEYAFTERREISSUEXXXXXXXXXXXXXXXXXXXXXXXXX";
const FAKE_USER_JWT_BODY = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.fakebody.fakesig";
const FAKE_CREDS = [
  "-----BEGIN NATS USER JWT-----",
  FAKE_USER_JWT_BODY,
  "------END NATS USER JWT------",
  "",
  "-----BEGIN USER NKEY SEED-----",
  "SUAFAKESEED",
  "------END USER NKEY SEED------",
].join("\n").replace(/------END NATS USER JWT------/, "-----END NATS USER JWT-----")
   .replace(/------END USER NKEY SEED------/, "-----END USER NKEY SEED-----");

const FAKE_USER_JWT_JSON = JSON.stringify({
  jti: "fake",
  iat: 0,
  iss: "AACCOUNT",
  sub: FAKE_USER_PUBKEY,
  name: TEST_BOT,
  nats: { type: "user" },
});

const NEW_USER_JWT_JSON = JSON.stringify({
  jti: "fake-new",
  iat: 0,
  iss: "AACCOUNT",
  sub: NEW_USER_PUBKEY,
  name: TEST_BOT,
  nats: { type: "user" },
});

function ok(stdout = ""): NscResult { return { exitCode: 0, stdout, stderr: "" }; }
function fail(stderr = "boom"): NscResult { return { exitCode: 1, stdout: "", stderr }; }

function keyFor(args: string[]): string {
  const first = args[0] ?? "";
  const second = args[1];
  if (second && !second.startsWith("-")) return `${first} ${second}`;
  return first;
}

function buildRunner(handlers: Record<string, (args: string[]) => NscResult>): NscRunner {
  return (args) => {
    const handler = handlers[keyFor(args)];
    if (!handler) throw new Error(`Test runner has no handler for: nsc ${args.join(" ")}`);
    return handler(args);
  };
}

function cleanupOutPath(): void {
  try { unlinkSync(CUSTOM_OUT); } catch { /* ignore */ }
  try { unlinkSync(`${CUSTOM_OUT}.bak`); } catch { /* ignore */ }
}

beforeEach(() => {
  __setNscInstallCheckForTests(() => true);
});

afterEach(() => {
  __setNscRunnerForTests(null);
  __setNscInstallCheckForTests(null);
  cleanupOutPath();
});

// ── addBot ────────────────────────────────────────────────────────────────

describe("addBot --json: success shape", () => {
  test("returns the documented arc.nats.v1 fields (bot, account, credsPath, jwt, pubKey)", async () => {
    const runner = buildRunner({
      // userExists check: no -J → throw is fine for "not found", but nsc
      // returns exit 1; we use exit 1 so userExists returns false.
      "describe user": (args) => {
        if (args.includes("-J")) return ok(FAKE_USER_JWT_JSON);
        return fail("user not found");
      },
      "add user": () => ok("added"),
      "generate creds": () => ok(FAKE_CREDS),
    });
    __setNscRunnerForTests(runner);

    const result = await addBot(TEST_BOT, {
      account: TEST_ACCOUNT,
      output: CUSTOM_OUT,
      json: true,
    });

    expect(result.bot).toBe(TEST_BOT);
    expect(result.account).toBe(TEST_ACCOUNT);
    expect(result.credsPath).toBe(CUSTOM_OUT);
    expect(result.pubKey).toBe(FAKE_USER_PUBKEY);
    expect(result.jwt).toBe(FAKE_USER_JWT_BODY);

    // The creds file is actually written and contains the JWT block.
    expect(existsSync(CUSTOM_OUT)).toBe(true);
  });
});

describe("addBot --json: error envelope", () => {
  test("ALREADY_EXISTS when user exists without --force", async () => {
    // Seed the creds file path-wise; userExists returns true (describe exit 0).
    mkdirSync(dirname(CUSTOM_OUT), { recursive: true, mode: 0o700 });
    writeFileSync(CUSTOM_OUT, "preexisting", { mode: 0o600 });

    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      await addBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("ALREADY_EXISTS");
  });

  test("NSC_NOT_INSTALLED when nsc is missing from PATH", async () => {
    __setNscInstallCheckForTests(() => false);
    let err: unknown;
    try {
      await addBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_NOT_INSTALLED");
  });

  test("VALIDATION_ERROR when bot name is invalid", async () => {
    const runner = buildRunner({});
    __setNscRunnerForTests(runner);
    let err: unknown;
    try {
      await addBot("BAD UPPERCASE", { account: TEST_ACCOUNT, output: CUSTOM_OUT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  // arc#169: nsc subcommands now throw ArcNatsCommandError("NSC_COMMAND_FAILED")
  // instead of plain Error. Pre-fix: a failing `nsc add user` (which runs
  // OUTSIDE the addBot try/catch) surfaced as code "UNKNOWN" at the CLI
  // boundary because classifyError() falls back for non-typed errors.
  test("arc#169: NSC_COMMAND_FAILED when `nsc add user` fails outside the rollback try", async () => {
    const runner = buildRunner({
      "describe user": () => fail("user not found"),
      "add user": () => fail("signing key missing for account OP_TEST_JSON"),
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      await addBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
    expect((err as ArcNatsCommandError).message).toContain("nsc add failed");
    expect((err as ArcNatsCommandError).message).toContain("signing key missing");
  });

  // Inside the rollback try, the catch-all preserves err.code (per validateSubject
  // arc#136 fix), so NSC_COMMAND_FAILED flows through with the "rolled back" message
  // wrapper. Operator gets both: precise code (nsc failed) AND the message
  // making clear a rollback ran.
  test("arc#169: NSC_COMMAND_FAILED preserved through rollback when `nsc edit user` fails", async () => {
    const calls: string[] = [];
    const handler = buildRunner({
      "describe user": (a) => a.includes("-J") ? ok(FAKE_USER_JWT_JSON) : fail("user not found"),
      "add user": () => ok("added"),
      "edit user": () => fail("permission denied: signing key not unlocked"),
      "delete user": () => ok("deleted"),
      "generate creds": () => ok(FAKE_CREDS),
    });
    __setNscRunnerForTests((args) => {
      calls.push(`${args[0]} ${args[1] ?? ""}`.trim());
      return handler(args);
    });

    let err: unknown;
    try {
      await addBot(TEST_BOT, {
        account: TEST_ACCOUNT,
        output: CUSTOM_OUT,
        json: true,
        pub: "valid.subject",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
    expect((err as ArcNatsCommandError).message).toContain("rolled back");
    expect((err as ArcNatsCommandError).message).toContain("permission denied");
    // Rollback actually ran: `nsc delete user` was invoked.
    expect(calls).toContain("delete user");
  });

  // arc#136: validateSubject used to throw a plain Error, which the addBot
  // catch-all rewrote as ROLLBACK_FAILED — the wrong code for an input
  // validation failure. The fix makes it throw VALIDATION_ERROR directly,
  // AND hoists validation above `nsc add user` so a bad subject never
  // triggers a real create + rollback round-trip in the first place.
  test("arc#136: VALIDATION_ERROR for an invalid --pub subject; fail-fast, no add/delete user", async () => {
    const calls: string[] = [];
    const handler = buildRunner({
      "describe user": (a) => a.includes("-J") ? ok(FAKE_USER_JWT_JSON) : fail("user not found"),
      "add user": () => ok("added"),
      "edit user": () => ok("edited"),
      "delete user": () => ok("deleted"),
      "generate creds": () => ok(FAKE_CREDS),
    });
    __setNscRunnerForTests((args) => {
      calls.push(`${args[0]} ${args[1] ?? ""}`.trim());
      return handler(args);
    });

    let err: unknown;
    try {
      await addBot(TEST_BOT, {
        account: TEST_ACCOUNT,
        output: CUSTOM_OUT,
        json: true,
        pub: "valid.subject,bad subject with spaces",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
    expect((err as ArcNatsCommandError).message).toContain("Invalid NATS subject");
    // Fail-fast: validation happens BEFORE any state-changing nsc calls,
    // so neither `add user` nor the rollback `delete user` ran.
    expect(calls).not.toContain("add user");
    expect(calls).not.toContain("delete user");
  });

  test("arc#136: VALIDATION_ERROR for an invalid --sub subject; fail-fast", async () => {
    const calls: string[] = [];
    const handler = buildRunner({
      "describe user": (a) => a.includes("-J") ? ok(FAKE_USER_JWT_JSON) : fail("user not found"),
      "add user": () => ok("added"),
      "edit user": () => ok("edited"),
      "delete user": () => ok("deleted"),
      "generate creds": () => ok(FAKE_CREDS),
    });
    __setNscRunnerForTests((args) => {
      calls.push(`${args[0]} ${args[1] ?? ""}`.trim());
      return handler(args);
    });

    let err: unknown;
    try {
      await addBot(TEST_BOT, {
        account: TEST_ACCOUNT,
        output: CUSTOM_OUT,
        json: true,
        sub: "ok.subject,$(evil-shell-meta)",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
    expect(calls).not.toContain("add user");
    expect(calls).not.toContain("delete user");
  });
});

// ── reissueBot ────────────────────────────────────────────────────────────

describe("reissueBot --json: success shape", () => {
  test("returns bot, account, credsPath, newPubKey, revokedPubKey", () => {
    const outDir = dirname(CUSTOM_OUT);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(CUSTOM_OUT, "OLD CREDS CONTENT", { mode: 0o600 });

    // describe -J is called twice: once for the OLD pubkey (revoke target),
    // then again after re-create for the NEW pubkey. Track call count.
    let describeJsonCount = 0;
    const runner = buildRunner({
      "describe user": (args) => {
        if (!args.includes("-J")) return ok("exists");
        describeJsonCount++;
        return describeJsonCount === 1 ? ok(FAKE_USER_JWT_JSON) : ok(NEW_USER_JWT_JSON);
      },
      "revocations add-user": () => ok("revoked"),
      "push": () => ok("pushed"),
      "delete user": () => ok("deleted"),
      "add user": () => ok("added"),
      "generate creds": () => ok(FAKE_CREDS),
    });
    __setNscRunnerForTests(runner);

    const result = reissueBot(TEST_BOT, {
      account: TEST_ACCOUNT,
      output: CUSTOM_OUT,
      json: true,
    });

    expect(result.bot).toBe(TEST_BOT);
    expect(result.account).toBe(TEST_ACCOUNT);
    expect(result.credsPath).toBe(CUSTOM_OUT);
    expect(result.revokedPubKey).toBe(FAKE_USER_PUBKEY);
    expect(result.newPubKey).toBe(NEW_USER_PUBKEY);
  });
});

describe("reissueBot --json: error envelope", () => {
  test("USER_NOT_FOUND when user does not exist", () => {
    const runner = buildRunner({
      "describe user": () => fail("not found"),
    });
    __setNscRunnerForTests(runner);
    let err: unknown;
    try {
      reissueBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT, json: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("USER_NOT_FOUND");
  });

  test("PUSH_FAILED when nsc push fails — does NOT delete locally", () => {
    const outDir = dirname(CUSTOM_OUT);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(CUSTOM_OUT, "OLD CREDS CONTENT", { mode: 0o600 });

    const calls: string[] = [];
    const runner: NscRunner = (args) => {
      calls.push(keyFor(args));
      const k = keyFor(args);
      if (k === "describe user") {
        return args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists");
      }
      if (k === "revocations add-user") return ok("revoked locally");
      if (k === "push") return fail("nats: timeout waiting for ACK");
      // delete/add/generate should never be reached
      return ok("unreachable");
    };
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      reissueBot(TEST_BOT, { account: TEST_ACCOUNT, output: CUSTOM_OUT, json: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("PUSH_FAILED");
    // Critical: delete user MUST NOT have been called.
    expect(calls).not.toContain("delete user");
    expect(calls).not.toContain("add user");
  });
});

// ── removeBot ─────────────────────────────────────────────────────────────

describe("removeBot --json: success shape", () => {
  test("returns bot, account, revokedPubKey, credsFileDeleted=false (no --delete-creds)", () => {
    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked"),
      "push": () => ok("pushed"),
      "delete user": () => ok("deleted"),
    });
    __setNscRunnerForTests(runner);

    const result = removeBot(TEST_BOT, { account: TEST_ACCOUNT, json: true });
    expect(result.bot).toBe(TEST_BOT);
    expect(result.account).toBe(TEST_ACCOUNT);
    expect(result.revokedPubKey).toBe(FAKE_USER_PUBKEY);
    expect(result.credsFileDeleted).toBe(false);
  });

  test("credsFileDeleted=true when --delete-creds flag present and file exists", () => {
    mkdirSync(dirname(CUSTOM_OUT), { recursive: true, mode: 0o700 });
    writeFileSync(CUSTOM_OUT, "creds-to-delete", { mode: 0o600 });

    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked"),
      "push": () => ok("pushed"),
      "delete user": () => ok("deleted"),
    });
    __setNscRunnerForTests(runner);

    const result = removeBot(TEST_BOT, {
      account: TEST_ACCOUNT,
      deleteCreds: true,
      output: CUSTOM_OUT,
      json: true,
    });
    expect(result.credsFileDeleted).toBe(true);
    expect(existsSync(CUSTOM_OUT)).toBe(false);
  });

  test("credsFileDeleted=false when --delete-creds set but file missing", () => {
    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked"),
      "push": () => ok("pushed"),
      "delete user": () => ok("deleted"),
    });
    __setNscRunnerForTests(runner);
    const result = removeBot(TEST_BOT, {
      account: TEST_ACCOUNT,
      deleteCreds: true,
      output: join(TMP_ROOT, "does-not-exist.creds"),
      json: true,
    });
    expect(result.credsFileDeleted).toBe(false);
  });
});

describe("removeBot --json: error envelope", () => {
  test("USER_NOT_FOUND when user is not present", () => {
    const runner = buildRunner({
      "describe user": () => fail("not found"),
    });
    __setNscRunnerForTests(runner);
    let err: unknown;
    try {
      removeBot(TEST_BOT, { account: TEST_ACCOUNT, json: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("USER_NOT_FOUND");
  });

  test("PUSH_FAILED when revoke push fails", () => {
    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => ok("revoked locally"),
      "push": () => fail("connection refused"),
    });
    __setNscRunnerForTests(runner);
    let err: unknown;
    try {
      removeBot(TEST_BOT, { account: TEST_ACCOUNT, json: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("PUSH_FAILED");
  });

  test("REVOKE_FAILED when nsc revocations add-user itself fails", () => {
    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : ok("exists"),
      "revocations add-user": () => fail("permission denied: account signing key required"),
    });
    __setNscRunnerForTests(runner);
    let err: unknown;
    try {
      removeBot(TEST_BOT, { account: TEST_ACCOUNT, json: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("REVOKE_FAILED");
  });
});

// ── setupOperator ─────────────────────────────────────────────────────────

describe("setupOperator --json: aggregate shape", () => {
  test("all-failure aggregate: every bot errors with VALIDATION_ERROR; summary reflects 0/N ok", async () => {
    // Two invalid bot names — validateBotName trips for each before any
    // filesystem or identity-registry side effect. Keeps the test hermetic.
    const runner = buildRunner({});
    __setNscRunnerForTests(runner);

    const result = await setupOperator(TEST_ACCOUNT, ["BAD-CASE", "also BAD"], {
      force: false,
      json: true,
    });

    expect(result.account).toBe(TEST_ACCOUNT);
    expect(result.bots).toHaveLength(2);
    expect(result.summary.total).toBe(2);
    expect(result.summary.ok).toBe(0);
    expect(result.summary.failed).toBe(2);

    for (const b of result.bots) {
      expect(b.ok).toBe(false);
      expect(b.error?.code).toBe("VALIDATION_ERROR");
    }
  });

  test("mixed outcome: one valid + one invalid name; summary 1 ok / 1 failed", async () => {
    // The valid bot's addBot call would proceed to filesystem + identity
    // writes; to keep this hermetic we shadow $HOME to a tmp directory so
    // nothing touches the real `~/.config/nats` or myelin registry.
    const TMP_HOME = mkdtempSync(join(tmpdir(), "arc-a131-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = TMP_HOME;

    const VALID_BOT = "arc-json-setupok";
    try {
      const runner = buildRunner({
        // Valid bot: user does not exist → addBot proceeds; describe -J after
        // create returns the JWT JSON.
        "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : fail("not found"),
        "add user": () => ok("added"),
        "generate creds": () => ok(FAKE_CREDS),
      });
      __setNscRunnerForTests(runner);

      const result = await setupOperator(TEST_ACCOUNT, [VALID_BOT, "BAD CASE"], {
        force: true, // force=true → identity overwrite is harmless under shadow $HOME
        json: true,
      });

      expect(result.bots).toHaveLength(2);
      expect(result.summary.ok).toBe(1);
      expect(result.summary.failed).toBe(1);

      const okBot = result.bots.find((b) => b.bot === VALID_BOT);
      const badBot = result.bots.find((b) => b.bot === "BAD CASE");
      expect(okBot?.ok).toBe(true);
      expect(okBot?.pubKey).toBe(FAKE_USER_PUBKEY);
      expect(badBot?.ok).toBe(false);
      expect(badBot?.error?.code).toBe("VALIDATION_ERROR");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  });
});

// ── Schema-stability snapshot ─────────────────────────────────────────────

describe("arc.nats.v1 schema stability", () => {
  test("schema string is exactly 'arc.nats.v1'", () => {
    expect(ARC_NATS_SCHEMA).toBe("arc.nats.v1");
  });

  test("AddBot success payload shape matches docs/integrations/cortex-creds.md", async () => {
    const runner = buildRunner({
      "describe user": (args) => args.includes("-J") ? ok(FAKE_USER_JWT_JSON) : fail("not found"),
      "add user": () => ok("added"),
      "generate creds": () => ok(FAKE_CREDS),
    });
    __setNscRunnerForTests(runner);

    const r = await addBot(TEST_BOT, {
      account: TEST_ACCOUNT,
      output: CUSTOM_OUT,
      json: true,
    });

    const envelope = {
      schema: ARC_NATS_SCHEMA,
      ok: true as const,
      bot: r.bot,
      account: r.account,
      credsPath: r.credsPath,
      jwt: r.jwt,
      pubKey: r.pubKey,
    };

    // Field set must be exactly these — no more, no less. Adding a field is a
    // breaking change requiring a schema bump (arc.nats.v2).
    expect(Object.keys(envelope).sort()).toEqual(
      ["account", "bot", "credsPath", "jwt", "ok", "pubKey", "schema"].sort(),
    );
  });
});
