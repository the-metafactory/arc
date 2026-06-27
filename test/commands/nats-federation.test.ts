/**
 * Tests for `arc nats add-federation-export` (G1b — cortex#1117).
 *
 * All nsc invocations are stubbed via `__setNscRunnerForTests` — no real nsc
 * operator is needed and no live hub is touched.
 *
 * Coverage:
 *   - Dry-run: prints the plan, no nsc mutations (no add export/import/push)
 *   - --apply: calls add export, add import, push both accounts in order
 *   - Idempotent re-run: both already present → no mutations, push still runs
 *   - Same account (Case A): no-op result, no nsc mutations
 *   - Account name validation (M1): empty, flag-injection, valid UPPER_SNAKE
 *   - Subject validation: VALIDATION_ERROR for invalid subjects
 *   - NSC_NOT_INSTALLED: typed error when nsc is missing
 *   - JSON envelope shape: schema, ok, field names, pushResult presence
 *   - Partial failure (import fails after export succeeds): error propagates,
 *     result is re-runnable (export skipped on re-run via idempotency check)
 *   - Multi-peer hub (M2): to-account already imports from peer A; peer B import is added
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  addFederationExport,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
  type NscResult,
  type NscRunner,
} from "../../src/commands/nats.js";
import { ArcNatsCommandError, ARC_NATS_FEDERATION_SCHEMA } from "../../src/lib/json-response.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FROM_ACCOUNT = "OP_PEER";
const TO_ACCOUNT = "OP_HUB";
const DEFAULT_SUBJECT = "federated.>";
const CUSTOM_SUBJECT = "federated.mynet.>";

// Fake account pubkeys for multi-peer tests (M2). Real NKeys start with "A".
const FROM_ACCOUNT_PUBKEY = "AFROM0000000000000000000000000000000000000000000000000000";
const PEER_A_PUBKEY       = "APEERA00000000000000000000000000000000000000000000000000";
const PEER_B_PUBKEY       = "APEERB00000000000000000000000000000000000000000000000000";

function ok(stdout = ""): NscResult { return { exitCode: 0, stdout, stderr: "" }; }
function fail(stderr = "boom"): NscResult { return { exitCode: 1, stdout: "", stderr }; }

/**
 * Build a fake `nsc describe account -n <account> -J` response.
 *
 * `sub` is the account's NKey public key ("A"-prefixed). The M2 fix uses
 * `extractAccountPubkey(describeJson)` → `json.sub` to resolve the exporting
 * account's pubkey, then matches imports on both `subject` AND `account`
 * (the pubkey of the exporting account). Tests that cover multi-peer idempotency
 * must supply matching `account` fields in their import entries.
 */
function describeAccountJson(opts: {
  sub?: string;
  exports?: { subject: string }[];
  imports?: { subject: string; account?: string }[];
} = {}): string {
  return JSON.stringify({
    jti: "fake",
    iat: 0,
    iss: "OOPERATOR",
    sub: opts.sub ?? FROM_ACCOUNT_PUBKEY,
    nats: {
      type: "account",
      exports: opts.exports ?? [],
      imports: opts.imports ?? [],
    },
  });
}

/**
 * Build a fake `nsc describe operator -J` response. `accountServerUrl`
 * controls whether the operator declares an account-JWT server — the signal
 * `operatorHasAccountServer()` reads to decide whether `nsc push` applies
 * (a `resolver: MEMORY` sovereign deployment has none → push is skipped).
 */
function describeOperatorJson(opts: { accountServerUrl?: string | null } = {}): string {
  const nats: Record<string, unknown> = { type: "operator" };
  if (opts.accountServerUrl != null) nats.account_server_url = opts.accountServerUrl;
  return JSON.stringify({ jti: "fake", iat: 0, iss: "OOPERATOR", sub: "OOPERATOR", nats });
}

/** Key for the buildRunner dispatch map: first two args (verb + noun). */
function keyFor(args: string[]): string {
  const verb = args[0] ?? "";
  const noun = args[1];
  if (noun && !noun.startsWith("-")) return `${verb} ${noun}`;
  return verb;
}

/**
 * Default `describe operator` handler injected when a test does not supply one:
 * an operator WITH an account-JWT server, so the `--apply` push step runs (the
 * pre-`operatorHasAccountServer` behaviour these tests were written against).
 * Tests covering the MEMORY-resolver skip path supply their own handler
 * returning {@link describeOperatorJson} with no `accountServerUrl`.
 */
const DEFAULT_OPERATOR_WITH_SERVER = "nats://hub.example:4222";

function buildRunner(handlers: Record<string, (args: string[]) => NscResult>): NscRunner {
  return (args) => {
    const k = keyFor(args);
    const handler =
      handlers[k] ??
      (k === "describe operator"
        ? () => ok(describeOperatorJson({ accountServerUrl: DEFAULT_OPERATOR_WITH_SERVER }))
        : undefined);
    if (!handler) throw new Error(`Test runner: no handler for nsc ${args.join(" ")}`);
    return handler(args);
  };
}

beforeEach(() => {
  __setNscInstallCheckForTests(() => true);
});

afterEach(() => {
  __setNscRunnerForTests(null);
  __setNscInstallCheckForTests(null);
});

// ── Same-account no-op (Case A) ───────────────────────────────────────────────

describe("addFederationExport — same-account (Case A)", () => {
  test("returns a no-op result without calling nsc at all", () => {
    // Runner should never be called — but set one up to fail loudly if it is.
    __setNscRunnerForTests(buildRunner({}));

    const result = addFederationExport({
      fromAccount: "OP_SAME",
      toAccount: "OP_SAME",
      json: true,
    });

    expect(result.fromAccount).toBe("OP_SAME");
    expect(result.toAccount).toBe("OP_SAME");
    expect(result.exportAdded).toBe(false);
    expect(result.importAdded).toBe(false);
    expect(result.exportAlreadyPresent).toBe(true);
    expect(result.importAlreadyPresent).toBe(true);
    expect(result.pushResult).toBeUndefined();
  });

  test("no-op result uses the correct subject default", () => {
    __setNscRunnerForTests(buildRunner({}));
    const result = addFederationExport({
      fromAccount: "XA",
      toAccount: "XA",
      json: true,
    });
    expect(result.subject).toBe(DEFAULT_SUBJECT);
  });

  test("no-op result respects a custom subject", () => {
    __setNscRunnerForTests(buildRunner({}));
    const result = addFederationExport({
      fromAccount: "XA",
      toAccount: "XA",
      subject: CUSTOM_SUBJECT,
      json: true,
    });
    expect(result.subject).toBe(CUSTOM_SUBJECT);
  });
});

// ── Dry-run (default) ─────────────────────────────────────────────────────────

describe("addFederationExport — dry-run (apply=false)", () => {
  test("does NOT call add export / add import / push — only describe", () => {
    const called: string[] = [];
    const runner = buildRunner({
      "describe account": (args) => {
        called.push(`describe account ${args[3] ?? ""}`);
        return ok(describeAccountJson());
      },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: false,
      json: true,
    });

    // Only describe calls should have happened — no add export/import, no push.
    expect(called).toHaveLength(2); // once for fromAccount, once for toAccount
    expect(called[0]).toContain(FROM_ACCOUNT);
    expect(called[1]).toContain(TO_ACCOUNT);

    // exportAdded / importAdded are false (nothing was written)
    expect(result.exportAdded).toBe(false);
    expect(result.importAdded).toBe(false);

    // pushResult marks both as skipped in dry-run
    expect(result.pushResult).toEqual({ fromAccount: "skipped", toAccount: "skipped" });
  });

  test("dry-run: exportAlreadyPresent=false when account has no matching export", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": () => ok(describeAccountJson()),
    }));

    const result = addFederationExport({ fromAccount: FROM_ACCOUNT, toAccount: TO_ACCOUNT, json: true });
    expect(result.exportAlreadyPresent).toBe(false);
    expect(result.importAlreadyPresent).toBe(false);
  });
});

// ── --apply: adds export + import + pushes ────────────────────────────────────

describe("addFederationExport — --apply path", () => {
  test("calls add export, add import, push fromAccount, push toAccount in order", () => {
    const sequence: string[] = [];

    // Actual execution order:
    //   Step 1: describe fromAccount
    //   Step 2: add export (fromAccount not present)
    //   Step 3: describe toAccount
    //   Step 4: add import (toAccount not present)
    //   Step 5: push fromAccount
    //   Step 6: push toAccount
    const runner = buildRunner({
      "describe account": (args) => {
        sequence.push(`describe account ${args[args.indexOf("-n") + 1] ?? ""}`);
        return ok(describeAccountJson()); // no existing exports/imports
      },
      "add export": (args) => {
        sequence.push(`add export --account ${args[args.indexOf("--account") + 1]}`);
        return ok();
      },
      "add import": (args) => {
        sequence.push(`add import --account ${args[args.indexOf("--account") + 1]}`);
        return ok();
      },
      "push": (args) => {
        sequence.push(`push -a ${args[args.indexOf("-a") + 1]}`);
        return ok();
      },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    expect(result.exportAdded).toBe(true);
    expect(result.importAdded).toBe(true);
    expect(result.exportAlreadyPresent).toBe(false);
    expect(result.importAlreadyPresent).toBe(false);
    expect(result.pushResult).toEqual({ fromAccount: "ok", toAccount: "ok" });

    // Verify all 6 nsc operations ran and in the correct order:
    // describe-from, add-export, describe-to, add-import, push-from, push-to
    expect(sequence).toHaveLength(6);
    expect(sequence[0]).toContain(FROM_ACCOUNT);    // describe fromAccount
    expect(sequence[1]).toContain(`add export`);     // add export
    expect(sequence[2]).toContain(TO_ACCOUNT);       // describe toAccount
    expect(sequence[3]).toContain(`add import`);     // add import
    expect(sequence[4]).toContain(`push -a ${FROM_ACCOUNT}`);
    expect(sequence[5]).toContain(`push -a ${TO_ACCOUNT}`);
  });

  test("passes --service flag to nsc add export when opts.service=true", () => {
    let exportArgs: string[] = [];
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": (args) => { exportArgs = args; return ok(); },
      "add import": () => ok(),
      "push": () => ok(),
    });
    __setNscRunnerForTests(runner);

    addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      service: true,
      json: true,
    });

    expect(exportArgs).toContain("--service");
  });

  test("does NOT pass --service when opts.service is absent", () => {
    let exportArgs: string[] = [];
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": (args) => { exportArgs = args; return ok(); },
      "add import": () => ok(),
      "push": () => ok(),
    });
    __setNscRunnerForTests(runner);

    addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    expect(exportArgs).not.toContain("--service");
  });

  test("passes custom subject to both add export and add import", () => {
    const calls: { verb: string; args: string[] }[] = [];
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": (args) => { calls.push({ verb: "export", args }); return ok(); },
      "add import": (args) => { calls.push({ verb: "import", args }); return ok(); },
      "push": () => ok(),
    });
    __setNscRunnerForTests(runner);

    addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      subject: CUSTOM_SUBJECT,
      apply: true,
      json: true,
    });

    const exportCall = calls.find(c => c.verb === "export");
    const importCall = calls.find(c => c.verb === "import");
    expect(exportCall?.args).toContain(CUSTOM_SUBJECT);
    expect(importCall?.args).toContain(CUSTOM_SUBJECT);
    // local-subject should also equal the subject
    const localSubIdx = importCall?.args.indexOf("--local-subject") ?? -1;
    expect(importCall?.args[localSubIdx + 1]).toBe(CUSTOM_SUBJECT);
  });
});

// ── nsc-argv CONTRACT (anti-rot guard for the cortex#1225 flag fix) ───────────
//
// The previous mock dispatched on verb+noun and IGNORED flags, so it returned
// success for ANY argv — including the broken `nsc add import --from-account
// <name> --subject <s>` (nsc has no `--from-account`/`--subject` on `add
// import`; it wants `--src-account <pubkey> --remote-subject --local-subject`).
// These tests pin the contract to REAL nsc's commander behaviour: an undefined
// flag exits non-zero with "unknown flag", so a wrong flag fails the test
// rather than passing a permissive mock.

describe("addFederationExport — nsc argv contract (cortex#1225)", () => {
  // The set of flags REAL `nsc` accepts per verb (`nsc add export|import --help`,
  // `nsc push --help`, `nsc describe --help`). Anything else → "unknown flag".
  const KNOWN_FLAGS: Record<string, Set<string>> = {
    "add export": new Set(["--account", "-a", "--subject", "-s", "--service", "-r", "--name", "-n"]),
    "add import": new Set(["--account", "-a", "--src-account", "--remote-subject", "--local-subject", "-s", "--service", "--name", "-n"]),
    "push": new Set(["-a", "--account", "-A", "--all"]),
    "describe account": new Set(["-n", "--name", "-J"]),
    "describe operator": new Set(["-J", "-n", "--name"]),
  };

  /** A runner that mimics nsc/commander: reject any flag not in KNOWN_FLAGS. */
  function nscContractRunner(opts: {
    fromPubkey?: string;
    accountServerUrl?: string | null;
    record?: string[][];
  } = {}): NscRunner {
    const fromPubkey = opts.fromPubkey ?? FROM_ACCOUNT_PUBKEY;
    return (args) => {
      opts.record?.push([...args]);
      const k = keyFor(args);
      const known = KNOWN_FLAGS[k];
      if (known) {
        for (const a of args) {
          if (a.startsWith("-") && !known.has(a)) {
            return { exitCode: 1, stdout: "", stderr: `Error: unknown flag: ${a}` };
          }
        }
      }
      if (k === "describe operator") return ok(describeOperatorJson({ accountServerUrl: opts.accountServerUrl ?? null }));
      if (k === "describe account") return ok(describeAccountJson({ sub: fromPubkey }));
      return ok();
    };
  }

  test("add import uses --src-account <pubkey> --remote-subject --local-subject (NOT --from-account/--subject)", () => {
    const record: string[][] = [];
    __setNscRunnerForTests(nscContractRunner({ record }));

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    // The whole chain SUCCEEDS — proves no flag tripped the unknown-flag guard.
    expect(result.exportAdded).toBe(true);
    expect(result.importAdded).toBe(true);

    const importArgs = record.find((a) => a[0] === "add" && a[1] === "import");
    expect(importArgs).toBeDefined();
    // Correct flags, with the PUBKEY (not the name) on --src-account.
    expect(importArgs).toContain("--src-account");
    expect(importArgs![importArgs!.indexOf("--src-account") + 1]).toBe(FROM_ACCOUNT_PUBKEY);
    expect(importArgs).toContain("--remote-subject");
    expect(importArgs).toContain("--local-subject");
    // The buggy flags must NOT appear.
    expect(importArgs).not.toContain("--from-account");
    expect(importArgs).not.toContain("--subject");

    // Export side stays on --account / --subject (those ARE its real flags).
    const exportArgs = record.find((a) => a[0] === "add" && a[1] === "export");
    expect(exportArgs).toContain("--account");
    expect(exportArgs).toContain("--subject");
  });

  test("a runner mimicking real nsc would FAIL the old --from-account import argv", () => {
    // Direct proof the guard bites: feed the OLD argv through the contract
    // runner and confirm it rejects it (regression cannot silently return).
    const runner = nscContractRunner();
    const bad = runner(["add", "import", "--account", TO_ACCOUNT, "--from-account", FROM_ACCOUNT, "--subject", DEFAULT_SUBJECT]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unknown flag");
  });
});

// ── push gating: nats-account-resolver vs resolver:MEMORY (sovereign local) ────

describe("addFederationExport — push gating on operator account-server", () => {
  test("operator WITHOUT account-server (resolver: MEMORY) → push is SKIPPED", () => {
    const calls: string[] = [];
    const runner = buildRunner({
      "describe operator": () => ok(describeOperatorJson({ accountServerUrl: null })),
      "describe account": () => ok(describeAccountJson()),
      "add export": () => { calls.push("add export"); return ok(); },
      "add import": () => { calls.push("add import"); return ok(); },
      "push": () => { calls.push("push"); return ok(); },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    // Wiring mutation still landed; push was skipped (no account server).
    expect(result.exportAdded).toBe(true);
    expect(result.importAdded).toBe(true);
    expect(result.pushResult).toEqual({ fromAccount: "skipped", toAccount: "skipped" });
    expect(calls).toContain("add export");
    expect(calls).toContain("add import");
    expect(calls).not.toContain("push");
  });

  test("operator WITH account-server → push runs", () => {
    const calls: string[] = [];
    const runner = buildRunner({
      "describe operator": () => ok(describeOperatorJson({ accountServerUrl: "nats://hub:4222" })),
      "describe account": () => ok(describeAccountJson()),
      "add export": () => ok(),
      "add import": () => ok(),
      "push": () => { calls.push("push"); return ok(); },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    expect(result.pushResult).toEqual({ fromAccount: "ok", toAccount: "ok" });
    expect(calls.filter((c) => c === "push")).toHaveLength(2);
  });
});

// ── Idempotent re-run ─────────────────────────────────────────────────────────

describe("addFederationExport — idempotency (both already present)", () => {
  test("skips add export and add import when both already exist; still pushes", () => {
    const calls: string[] = [];
    // M2: import entry must include `account` (the fromAccount pubkey) so the
    // source-account match detects the import as already present.
    const descWithBoth = describeAccountJson({
      exports: [{ subject: DEFAULT_SUBJECT }],
      imports: [{ subject: DEFAULT_SUBJECT, account: FROM_ACCOUNT_PUBKEY }],
    });

    const runner = buildRunner({
      "describe account": (args) => {
        calls.push(`describe ${args[3] ?? ""}`);
        return ok(descWithBoth);
      },
      "push": (args) => {
        calls.push(`push ${args[2] ?? ""}`);
        return ok();
      },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    expect(result.exportAlreadyPresent).toBe(true);
    expect(result.importAlreadyPresent).toBe(true);
    expect(result.exportAdded).toBe(false);
    expect(result.importAdded).toBe(false);
    // Push still runs even when no mutations were needed
    expect(result.pushResult).toEqual({ fromAccount: "ok", toAccount: "ok" });

    // No add export / add import calls
    expect(calls.some(c => c.startsWith("describe"))).toBe(true);
    expect(calls.some(c => c.startsWith("push"))).toBe(true);
  });

  test("re-run after partial failure: export present, import not → only imports + push", () => {
    const calls: string[] = [];
    const descFrom = describeAccountJson({
      exports: [{ subject: DEFAULT_SUBJECT }], // export already present
      imports: [],
    });
    const descTo = describeAccountJson({
      exports: [],
      imports: [], // import NOT present yet
    });
    let descCallCount = 0;

    const runner = buildRunner({
      "describe account": (args) => {
        descCallCount++;
        calls.push(`describe ${args[3] ?? ""}`);
        return ok(descCallCount === 1 ? descFrom : descTo);
      },
      "add import": (args) => {
        calls.push(`add import --account ${args[args.indexOf("--account") + 1]}`);
        return ok();
      },
      "push": (args) => {
        calls.push(`push ${args[2] ?? ""}`);
        return ok();
      },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    // Export was already present (skipped), import was added
    expect(result.exportAlreadyPresent).toBe(true);
    expect(result.exportAdded).toBe(false);
    expect(result.importAlreadyPresent).toBe(false);
    expect(result.importAdded).toBe(true);
    expect(result.pushResult).toEqual({ fromAccount: "ok", toAccount: "ok" });

    expect(calls.some(c => c.includes("add import"))).toBe(true);
    // No add export call
    expect(calls.some(c => c.includes("add export"))).toBe(false);
  });
});

// ── NSC_NOT_INSTALLED ─────────────────────────────────────────────────────────

describe("addFederationExport — NSC_NOT_INSTALLED", () => {
  test("throws ArcNatsCommandError with code NSC_NOT_INSTALLED when nsc missing", () => {
    __setNscInstallCheckForTests(() => false);

    let err: unknown;
    try {
      addFederationExport({ fromAccount: FROM_ACCOUNT, toAccount: TO_ACCOUNT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_NOT_INSTALLED");
  });
});

// ── Validation: invalid subject ───────────────────────────────────────────────

describe("addFederationExport — subject validation", () => {
  test("throws VALIDATION_ERROR for a subject with shell metacharacters", () => {
    __setNscRunnerForTests(buildRunner({}));

    let err: unknown;
    try {
      addFederationExport({
        fromAccount: FROM_ACCOUNT,
        toAccount: TO_ACCOUNT,
        subject: "federated.$(evil)",
        json: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for a subject with spaces", () => {
    __setNscRunnerForTests(buildRunner({}));

    let err: unknown;
    try {
      addFederationExport({
        fromAccount: FROM_ACCOUNT,
        toAccount: TO_ACCOUNT,
        subject: "federated. badsubject",
        json: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });
});

// ── NSC_COMMAND_FAILED: add export fails ──────────────────────────────────────

describe("addFederationExport — nsc failure propagation", () => {
  test("throws NSC_COMMAND_FAILED when nsc add export exits non-zero", () => {
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": () => fail("nsc add export: account not found"),
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      addFederationExport({
        fromAccount: FROM_ACCOUNT,
        toAccount: TO_ACCOUNT,
        apply: true,
        json: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });

  test("throws NSC_COMMAND_FAILED when nsc add import exits non-zero", () => {
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": () => ok(),
      "add import": () => fail("nsc add import: account not found"),
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      addFederationExport({
        fromAccount: FROM_ACCOUNT,
        toAccount: TO_ACCOUNT,
        apply: true,
        json: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });

  test("throws NSC_COMMAND_FAILED when push exits non-zero", () => {
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": () => ok(),
      "add import": () => ok(),
      "push": () => fail("nsc push: connection refused"),
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      addFederationExport({
        fromAccount: FROM_ACCOUNT,
        toAccount: TO_ACCOUNT,
        apply: true,
        json: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
  });
});

// ── JSON envelope shape ───────────────────────────────────────────────────────

describe("addFederationExport — JSON envelope shape", () => {
  test("success envelope has schema=arc.nats.federation.v1 and all required fields", () => {
    const runner = buildRunner({
      "describe account": () => ok(describeAccountJson()),
      "add export": () => ok(),
      "add import": () => ok(),
      "push": () => ok(),
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    // Shape matches AddFederationExportResult (the function-level contract;
    // CLI wraps with schema + ok)
    expect(result.fromAccount).toBe(FROM_ACCOUNT);
    expect(result.toAccount).toBe(TO_ACCOUNT);
    expect(result.subject).toBe(DEFAULT_SUBJECT);
    expect(typeof result.exportAdded).toBe("boolean");
    expect(typeof result.importAdded).toBe("boolean");
    expect(typeof result.exportAlreadyPresent).toBe("boolean");
    expect(typeof result.importAlreadyPresent).toBe("boolean");
    expect(result.pushResult).toBeDefined();
    expect(result.pushResult?.fromAccount).toBe("ok");
    expect(result.pushResult?.toAccount).toBe("ok");

    // Verify the schema constant is correct
    expect(ARC_NATS_FEDERATION_SCHEMA).toBe("arc.nats.federation.v1");
  });

  test("dry-run envelope has pushResult with both skipped", () => {
    __setNscRunnerForTests(buildRunner({
      "describe account": () => ok(describeAccountJson()),
    }));

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: false,
      json: true,
    });

    expect(result.pushResult).toEqual({ fromAccount: "skipped", toAccount: "skipped" });
  });

  test("same-account result has no pushResult (undefined)", () => {
    __setNscRunnerForTests(buildRunner({}));

    const result = addFederationExport({
      fromAccount: "SAME",
      toAccount: "SAME",
      json: true,
    });

    expect(result.pushResult).toBeUndefined();
  });
});

// ── describe JSON resilience ──────────────────────────────────────────────────

describe("addFederationExport — describe output resilience", () => {
  test("non-JSON describe: export fails open (added), import fails LOUD (no src-account pubkey)", () => {
    // `nsc add import` names the source account by PUBKEY (`--src-account A…`),
    // resolved from `nsc describe account -n <fromAccount> -J`. When describe
    // emits non-JSON (older nsc), the pubkey can't be resolved — the export
    // still adds (it only needs the account NAME), but the import MUST fail
    // loudly rather than emit a broken `--src-account <name>` invocation.
    const sequence: string[] = [];
    const runner = buildRunner({
      "describe account": () => ok("Account: OP_PEER\nNo JWT output"),
      "add export": () => { sequence.push("add export"); return ok(); },
      "add import": () => { sequence.push("add import"); return ok(); },
      "push": () => { sequence.push("push"); return ok(); },
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      addFederationExport({ fromAccount: FROM_ACCOUNT, toAccount: TO_ACCOUNT, apply: true, json: true });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
    expect((err as ArcNatsCommandError).message).toContain("src-account");
    // Export was added (fail-open); import + push never ran (loud failure).
    expect(sequence).toContain("add export");
    expect(sequence).not.toContain("add import");
    expect(sequence).not.toContain("push");
  });

  test("describe throws: export fails open (added), import fails LOUD (no src-account pubkey)", () => {
    let addExportCalled = false;
    let addImportCalled = false;
    const runner = buildRunner({
      "describe account": () => fail("nsc describe: account not found"),
      "add export": () => { addExportCalled = true; return ok(); },
      "add import": () => { addImportCalled = true; return ok(); },
      "push": () => ok(),
    });
    __setNscRunnerForTests(runner);

    let err: unknown;
    try {
      addFederationExport({ fromAccount: FROM_ACCOUNT, toAccount: TO_ACCOUNT, apply: true, json: true });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("NSC_COMMAND_FAILED");
    expect(addExportCalled).toBe(true);   // export fails open
    expect(addImportCalled).toBe(false);  // import never attempts a broken invocation
  });
});

// ── M1: Account name validation ───────────────────────────────────────────────

describe("addFederationExport — account name validation (M1)", () => {
  test("throws VALIDATION_ERROR for an empty fromAccount", () => {
    __setNscRunnerForTests(buildRunner({}));

    let err: unknown;
    try {
      addFederationExport({ fromAccount: "", toAccount: TO_ACCOUNT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for a flag-injection fromAccount (--all)", () => {
    __setNscRunnerForTests(buildRunner({}));

    let err: unknown;
    try {
      addFederationExport({ fromAccount: "--all", toAccount: TO_ACCOUNT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for a flag-injection toAccount (--force)", () => {
    __setNscRunnerForTests(buildRunner({}));

    let err: unknown;
    try {
      addFederationExport({ fromAccount: FROM_ACCOUNT, toAccount: "--force", json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("throws VALIDATION_ERROR for a lowercase account name", () => {
    __setNscRunnerForTests(buildRunner({}));

    let err: unknown;
    try {
      addFederationExport({ fromAccount: "op_peer", toAccount: TO_ACCOUNT, json: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArcNatsCommandError);
    expect((err as ArcNatsCommandError).code).toBe("VALIDATION_ERROR");
  });

  test("accepts valid UPPER_SNAKE account names without throwing", () => {
    // Valid names must not throw — runner is set to fail loudly if nsc is called
    // (which it won't be in dry-run mode after validation passes).
    __setNscRunnerForTests(buildRunner({
      "describe account": () => ok(describeAccountJson()),
    }));

    // Should not throw
    const result = addFederationExport({
      fromAccount: "OP_PEER",
      toAccount: "OP_HUB",
      apply: false,
      json: true,
    });
    expect(result.fromAccount).toBe("OP_PEER");
    expect(result.toAccount).toBe("OP_HUB");
  });
});

// ── M2: Multi-peer hub — import matched on subject + source account ───────────

describe("addFederationExport — multi-peer hub import matching (M2)", () => {
  test("adds import when toAccount already imports same subject from a DIFFERENT peer", () => {
    // Scenario: hub account (TO_ACCOUNT / OP_HUB) already has an import for
    // "federated.>" from peer A (PEER_A_PUBKEY). We are now calling with
    // from-account = peer B (PEER_B_PUBKEY). With subject-only matching the
    // import would be silently skipped; with M2 source-account matching it
    // must be added.
    const calls: string[] = [];

    const runner = buildRunner({
      "describe account": (args) => {
        const accountArg = args[args.indexOf("-n") + 1] ?? "";
        calls.push(`describe ${accountArg}`);

        if (accountArg === "OP_PEER_B") {
          // fromAccount describe → expose peer B's pubkey
          return ok(describeAccountJson({
            sub: PEER_B_PUBKEY,
            exports: [],
          }));
        }
        // toAccount (OP_HUB) describe → already has import from peer A, not B
        return ok(describeAccountJson({
          sub: "AHUB0000000000000000000000000000000000000000000000000000",
          imports: [{ subject: DEFAULT_SUBJECT, account: PEER_A_PUBKEY }],
        }));
      },
      "add export": (args) => { calls.push(`add export ${args[args.indexOf("--account") + 1]}`); return ok(); },
      "add import": (args) => { calls.push(`add import ${args[args.indexOf("--account") + 1]}`); return ok(); },
      "push": (args) => { calls.push(`push ${args[args.indexOf("-a") + 1]}`); return ok(); },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: "OP_PEER_B",
      toAccount: "OP_HUB",
      apply: true,
      json: true,
    });

    // Import from peer B must be ADDED (peer A's import does NOT satisfy this)
    expect(result.importAlreadyPresent).toBe(false);
    expect(result.importAdded).toBe(true);

    // Both export (peer B had none) and import were added
    expect(result.exportAdded).toBe(true);
    expect(calls.some(c => c.includes("add import"))).toBe(true);
    expect(result.pushResult).toEqual({ fromAccount: "ok", toAccount: "ok" });
  });

  test("does NOT add import when toAccount already imports same subject from the SAME peer", () => {
    // Scenario: idempotent re-run for peer B — import from peer B already present.
    __setNscRunnerForTests(buildRunner({
      "describe account": (args) => {
        const accountArg = args[args.indexOf("-n") + 1] ?? "";
        if (accountArg === "OP_PEER_B") {
          return ok(describeAccountJson({
            sub: PEER_B_PUBKEY,
            exports: [{ subject: DEFAULT_SUBJECT }],
          }));
        }
        return ok(describeAccountJson({
          sub: "AHUB0000000000000000000000000000000000000000000000000000",
          imports: [{ subject: DEFAULT_SUBJECT, account: PEER_B_PUBKEY }],
        }));
      },
      "push": () => ok(),
    }));

    const result = addFederationExport({
      fromAccount: "OP_PEER_B",
      toAccount: "OP_HUB",
      apply: true,
      json: true,
    });

    expect(result.importAlreadyPresent).toBe(true);
    expect(result.importAdded).toBe(false);
    expect(result.exportAlreadyPresent).toBe(true);
    expect(result.exportAdded).toBe(false);
  });
});
