/**
 * Tests for `arc nats init-operator` + `arc nats add-account` (arc#252).
 *
 * These are the sovereign-operator topology primitives that
 * `cortex network provision` (cortex#1139, Model-B sovereign federation) wraps
 * alongside the existing `add-bot` + `add-federation-export`. Each principal
 * runs their OWN nsc operator and mints their own accounts; arc owns the nsc
 * boundary, cortex orchestrates but never runs nsc itself.
 *
 * All nsc invocations are stubbed via `__setNscRunnerForTests` — no real nsc
 * operator is needed and nothing is written to the live keystore.
 *
 * Coverage:
 *   init-operator
 *     - creates the operator when absent (nsc add operator)
 *     - idempotent no-op when the operator already exists (no add operator)
 *     - --force recreates an existing operator (nsc add operator --force)
 *     - no-clobber: default never overwrites an existing operator
 *     - resolves the name from the current operator (nsc env) when --name omitted
 *     - VALIDATION_ERROR when no --name and no current operator
 *     - operator-name validation (empty / flag-injection)
 *     - keystore seed perms re-asserted to 0o600
 *     - NSC_NOT_INSTALLED + NSC_COMMAND_FAILED propagation
 *   add-account
 *     - creates the account when absent (nsc add account)
 *     - idempotent no-op when the account already exists (no add account)
 *     - callable repeatedly with DISTINCT names (federation + per-stack agents)
 *     - account-name validation (lowercase / flag-injection / empty)
 *     - NSC_NOT_INSTALLED + NSC_COMMAND_FAILED propagation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initOperator,
  addAccount,
  exportAccount,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { ArcNatsCommandError } from "../../src/lib/json-response.js";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ───────────────────────────────────────────────────────────────────

const OP_NAME = "OP_ANDREAS";
const OP_PUBKEY = "OAFAKEOPERATORPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const ACCT_FEDERATION = "FEDERATION";
const ACCT_AGENTS = "ANDREAS_AGENTS";
const ACCT_PUBKEY = "AAFAKEACCOUNTPUBKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function ok(stdout = ""): NscResult { return { exitCode: 0, stdout, stderr: "" }; }
function fail(stderr = "boom"): NscResult { return { exitCode: 1, stdout: "", stderr }; }

/** `nsc describe <kind> -n <name> -F sub` emits a JSON string literal. */
function subField(pubkey: string): NscResult { return ok(JSON.stringify(pubkey)); }

/** Key for the buildRunner dispatch map: first two args (verb + noun). */
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

/** Standard `nsc env` table carrying a current operator (or none). */
function envOutput(currentOperator: string | null): NscResult {
  const op = currentOperator ?? "";
  return ok(
    [
      "+--------------------------+",
      "| Setting | Set | Effective Value |",
      `| Current Operator         |     | ${op} |`,
      `| Current Account          |     | SOME_ACCOUNT |`,
    ].join("\n"),
  );
}

beforeEach(() => {
  __setNscInstallCheckForTests(() => true);
});

afterEach(() => {
  __setNscRunnerForTests(null);
  __setNscInstallCheckForTests(null);
});

// ── init-operator: create when absent ─────────────────────────────────────────

describe("initOperator — create when absent", () => {
  test("calls nsc add operator when the operator does not exist", () => {
    const calls: string[] = [];
    let operatorCreated = false;
    __setNscRunnerForTests(buildRunner({
      "describe operator": () => (operatorCreated ? subField(OP_PUBKEY) : fail("operator not found")),
      "add operator": (args) => {
        calls.push(`add operator ${args.includes("--force") ? "--force" : ""}`.trim());
        operatorCreated = true;
        return ok(`[ OK ] added operator "${OP_NAME}"`);
      },
    }));

    const result = initOperator({ name: OP_NAME, json: true });

    expect(calls).toContain("add operator");
    expect(result.operator).toBe(OP_NAME);
    expect(result.created).toBe(true);
    expect(result.alreadyExisted).toBe(false);
    expect(result.pubKey).toBe(OP_PUBKEY);
  });

  test("does NOT pass --force on a fresh create", () => {
    let addArgs: string[] = [];
    let operatorCreated = false;
    __setNscRunnerForTests(buildRunner({
      "describe operator": () => (operatorCreated ? subField(OP_PUBKEY) : fail("not found")),
      "add operator": (args) => { addArgs = args; operatorCreated = true; return ok(); },
    }));

    initOperator({ name: OP_NAME, json: true });
    expect(addArgs).not.toContain("--force");
  });
});

// ── init-operator: idempotent no-op when present ──────────────────────────────

describe("initOperator — idempotent no-op when present", () => {
  test("does NOT call add operator when the operator already exists", () => {
    const calls: string[] = [];
    __setNscRunnerForTests(buildRunner({
      "describe operator": () => subField(OP_PUBKEY),
      "add operator": () => { calls.push("add operator"); return ok(); },
    }));

    const result = initOperator({ name: OP_NAME, json: true });

    expect(calls).toHaveLength(0);
    expect(result.created).toBe(false);
    expect(result.alreadyExisted).toBe(true);
    expect(result.pubKey).toBe(OP_PUBKEY);
  });
});

// ── init-operator: --force recreate ───────────────────────────────────────────

describe("initOperator — --force recreate", () => {
  test("passes --force to nsc add operator when the operator exists and --force is set", () => {
    let addArgs: string[] = [];
    __setNscRunnerForTests(buildRunner({
      "describe operator": () => subField(OP_PUBKEY),
      "add operator": (args) => { addArgs = args; return ok(); },
    }));

    const result = initOperator({ name: OP_NAME, force: true, json: true });

    expect(addArgs).toContain("--force");
    expect(result.created).toBe(true);
    expect(result.alreadyExisted).toBe(true);
  });
});

// ── init-operator: name resolution from current operator ──────────────────────

describe("initOperator — name resolution", () => {
  test("resolves the operator name from `nsc env` when --name is omitted", () => {
    __setNscRunnerForTests(buildRunner({
      "env": () => envOutput(OP_NAME),
      "describe operator": () => subField(OP_PUBKEY),
    }));

    const result = initOperator({ json: true });
    expect(result.operator).toBe(OP_NAME);
    expect(result.alreadyExisted).toBe(true);
  });

  test("throws VALIDATION_ERROR when --name is omitted and there is no current operator", () => {
    __setNscRunnerForTests(buildRunner({
      "env": () => envOutput(null),
    }));

    let err: unknown;
    try {
      initOperator({ json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });
});

// ── init-operator: validation ─────────────────────────────────────────────────

describe("initOperator — operator name validation", () => {
  test("throws VALIDATION_ERROR for a flag-injection name (--all)", () => {
    __setNscRunnerForTests(buildRunner({}));
    let err: unknown;
    try {
      initOperator({ name: "--all", json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for an empty explicit name", () => {
    __setNscRunnerForTests(buildRunner({}));
    let err: unknown;
    try {
      initOperator({ name: "", json: true });
    } catch (e) {
      err = e;
    }
    // Empty --name falls through to current-operator detection, which (with no
    // runner env handler available) yields no operator → VALIDATION_ERROR.
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });
});

// ── init-operator: keystore seed permissions ──────────────────────────────────

describe("initOperator — keystore seed perms (0o600)", () => {
  const prevNkeys = process.env.NKEYS_PATH;
  let keystore: string;

  beforeEach(() => {
    keystore = mkdtempSync(join(tmpdir(), "arc-nats-keystore-"));
    process.env.NKEYS_PATH = keystore;
  });

  afterEach(() => {
    if (prevNkeys === undefined) delete process.env.NKEYS_PATH;
    else process.env.NKEYS_PATH = prevNkeys;
    rmSync(keystore, { recursive: true, force: true });
  });

  test("re-asserts 0o600 on the operator keystore seed and returns its path", () => {
    // Pre-create a loosely-permissioned keystore seed at the nsc layout path:
    //   <NKEYS_PATH>/keys/O/<pub[1:3]>/<pub>.nk
    const seedPath = join(keystore, "keys", "O", OP_PUBKEY.slice(1, 3), `${OP_PUBKEY}.nk`);
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, "SOFAKEOPERATORSEED", { mode: 0o644 });

    __setNscRunnerForTests(buildRunner({
      "describe operator": () => subField(OP_PUBKEY),
    }));

    const result = initOperator({ name: OP_NAME, json: true });

    expect(result.seedPath).toBe(seedPath);
    expect(statSync(seedPath).mode & 0o777).toBe(0o600);
  });
});

// ── init-operator: nsc plumbing failures ──────────────────────────────────────

describe("initOperator — nsc plumbing", () => {
  test("throws NSC_NOT_INSTALLED when nsc is missing", () => {
    __setNscInstallCheckForTests(() => false);
    let err: unknown;
    try {
      initOperator({ name: OP_NAME, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_NOT_INSTALLED");
  });

  test("throws NSC_COMMAND_FAILED when nsc add operator exits non-zero", () => {
    __setNscRunnerForTests(buildRunner({
      "describe operator": () => fail("not found"),
      "add operator": () => fail("nsc add operator: store is read-only"),
    }));

    let err: unknown;
    try {
      initOperator({ name: OP_NAME, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });
});

// ── add-account: create when absent ───────────────────────────────────────────

describe("addAccount — create when absent", () => {
  test("calls nsc add account when the account does not exist", () => {
    const calls: string[] = [];
    let accountCreated = false;
    __setNscRunnerForTests(buildRunner({
      "describe account": () => (accountCreated ? subField(ACCT_PUBKEY) : fail("account not found")),
      "add account": (args) => {
        calls.push(`add account ${args[args.indexOf("-n") + 1]}`);
        accountCreated = true;
        return ok(`[ OK ] added account "${ACCT_FEDERATION}"`);
      },
    }));

    const result = addAccount(ACCT_FEDERATION, { json: true });

    expect(calls).toContain(`add account ${ACCT_FEDERATION}`);
    expect(result.account).toBe(ACCT_FEDERATION);
    expect(result.created).toBe(true);
    expect(result.alreadyExisted).toBe(false);
    expect(result.pubKey).toBe(ACCT_PUBKEY);
  });
});

// ── add-account: idempotent no-op ─────────────────────────────────────────────

describe("addAccount — idempotent no-op when present", () => {
  test("does NOT call add account when the account already exists", () => {
    const calls: string[] = [];
    __setNscRunnerForTests(buildRunner({
      "describe account": () => subField(ACCT_PUBKEY),
      "add account": () => { calls.push("add account"); return ok(); },
    }));

    const result = addAccount(ACCT_AGENTS, { json: true });

    expect(calls).toHaveLength(0);
    expect(result.created).toBe(false);
    expect(result.alreadyExisted).toBe(true);
    expect(result.pubKey).toBe(ACCT_PUBKEY);
  });
});

// ── add-account: distinct names callable repeatedly ───────────────────────────

describe("addAccount — distinct names (federation + per-stack agents)", () => {
  test("creates two distinct accounts in sequence under the same operator", () => {
    const created = new Set<string>();
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) => {
        const name = args[args.indexOf("-n") + 1] ?? "";
        return created.has(name) ? subField(ACCT_PUBKEY) : fail("not found");
      },
      "add account": (args) => {
        const name = args[args.indexOf("-n") + 1] ?? "";
        created.add(name);
        return ok();
      },
    }));

    const fed = addAccount(ACCT_FEDERATION, { json: true });
    const agents = addAccount(ACCT_AGENTS, { json: true });

    expect(fed.account).toBe(ACCT_FEDERATION);
    expect(fed.created).toBe(true);
    expect(agents.account).toBe(ACCT_AGENTS);
    expect(agents.created).toBe(true);
    expect(created.has(ACCT_FEDERATION)).toBe(true);
    expect(created.has(ACCT_AGENTS)).toBe(true);

    // Re-running federation is now an idempotent no-op.
    const fedAgain = addAccount(ACCT_FEDERATION, { json: true });
    expect(fedAgain.created).toBe(false);
    expect(fedAgain.alreadyExisted).toBe(true);
  });
});

// ── add-account: validation ───────────────────────────────────────────────────

describe("addAccount — account name validation", () => {
  test("throws VALIDATION_ERROR for a lowercase account name", () => {
    __setNscRunnerForTests(buildRunner({}));
    let err: unknown;
    try {
      addAccount("federation", { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for a flag-injection account name (--all)", () => {
    __setNscRunnerForTests(buildRunner({}));
    let err: unknown;
    try {
      addAccount("--all", { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for an empty account name", () => {
    __setNscRunnerForTests(buildRunner({}));
    let err: unknown;
    try {
      addAccount("", { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });
});

// ── add-account: nsc plumbing failures ────────────────────────────────────────

describe("addAccount — nsc plumbing", () => {
  test("throws NSC_NOT_INSTALLED when nsc is missing", () => {
    __setNscInstallCheckForTests(() => false);
    let err: unknown;
    try {
      addAccount(ACCT_FEDERATION, { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_NOT_INSTALLED");
  });

  test("throws NSC_COMMAND_FAILED when nsc add account exits non-zero", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": () => fail("not found"),
      "add account": () => fail("nsc add account: no operator set"),
    }));

    let err: unknown;
    try {
      addAccount(ACCT_FEDERATION, { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });
});

// ── export-account: read account JWT + seed path (cortex#1257 make-live) ───────

describe("exportAccount — read-only JWT + seed export", () => {
  const FAKE_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBQUZBS0UifQ.sig";

  test("returns the account pubkey + raw JWT (no nsc mutation)", () => {
    const calls: string[] = [];
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) => {
        calls.push(args.join(" "));
        // tryGetPubKey uses `-F sub`; the JWT export uses `--raw`.
        if (args.includes("--raw")) return ok(`${FAKE_JWT}\n`);
        return subField(ACCT_PUBKEY);
      },
    }));

    const result = exportAccount(ACCT_AGENTS, { json: true });

    expect(result.account).toBe(ACCT_AGENTS);
    expect(result.pubKey).toBe(ACCT_PUBKEY);
    expect(result.jwt).toBe(FAKE_JWT);
    // Read-only: only `describe` was ever invoked — never `add` / `edit` / `delete`.
    expect(calls.every((c) => c.startsWith("describe"))).toBe(true);
  });

  test("ACCOUNT_NOT_FOUND when the account does not exist", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": () => fail("account not found"),
    }));

    let err: unknown;
    try {
      exportAccount("ANDREAS_NOPE", { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("ACCOUNT_NOT_FOUND");
  });

  test("NSC_COMMAND_FAILED when describe --raw returns a non-JWT", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) => (args.includes("--raw") ? ok("not-a-jwt") : subField(ACCT_PUBKEY)),
    }));

    let err: unknown;
    try {
      exportAccount(ACCT_AGENTS, { json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });

  test("account-name validation rejects flag-injection", () => {
    __setNscRunnerForTests(buildRunner({}));
    expect(() => exportAccount("--all", { json: true })).toThrow(ArcNatsCommandError);
  });
});
