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
 *   - Malformed account / invalid subject: VALIDATION_ERROR thrown
 *   - NSC_NOT_INSTALLED: typed error when nsc is missing
 *   - JSON envelope shape: schema, ok, field names, pushResult presence
 *   - Partial failure (import fails after export succeeds): error propagates,
 *     result is re-runnable (export skipped on re-run via idempotency check)
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

function ok(stdout = ""): NscResult { return { exitCode: 0, stdout, stderr: "" }; }
function fail(stderr = "boom"): NscResult { return { exitCode: 1, stdout: "", stderr }; }

/**
 * Build a fake `nsc describe account -n <account> -J` response.
 * The nsc JWT contains exports/imports under `.nats`.
 */
function describeAccountJson(opts: {
  exports?: { subject: string }[];
  imports?: { subject: string; account?: string }[];
} = {}): string {
  return JSON.stringify({
    jti: "fake",
    iat: 0,
    iss: "OOPERATOR",
    sub: "AACCOUNT",
    nats: {
      type: "account",
      exports: opts.exports ?? [],
      imports: opts.imports ?? [],
    },
  });
}

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
      fromAccount: "X",
      toAccount: "X",
      json: true,
    });
    expect(result.subject).toBe(DEFAULT_SUBJECT);
  });

  test("no-op result respects a custom subject", () => {
    __setNscRunnerForTests(buildRunner({}));
    const result = addFederationExport({
      fromAccount: "X",
      toAccount: "X",
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

// ── Idempotent re-run ─────────────────────────────────────────────────────────

describe("addFederationExport — idempotency (both already present)", () => {
  test("skips add export and add import when both already exist; still pushes", () => {
    const calls: string[] = [];
    const descWithBoth = describeAccountJson({
      exports: [{ subject: DEFAULT_SUBJECT }],
      imports: [{ subject: DEFAULT_SUBJECT }],
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
  test("treats non-JSON describe output as no existing export/import (fail open)", () => {
    const sequence: string[] = [];
    const runner = buildRunner({
      // Some nsc versions emit text, not JSON — treat as no existing entries
      "describe account": () => ok("Account: OP_PEER\nNo JWT output"),
      "add export": (args) => { sequence.push("add export"); return ok(); },
      "add import": (args) => { sequence.push("add import"); return ok(); },
      "push": (args) => { sequence.push("push"); return ok(); },
    });
    __setNscRunnerForTests(runner);

    const result = addFederationExport({
      fromAccount: FROM_ACCOUNT,
      toAccount: TO_ACCOUNT,
      apply: true,
      json: true,
    });

    // Non-JSON → treated as no existing entries → both are added
    expect(result.exportAdded).toBe(true);
    expect(result.importAdded).toBe(true);
    expect(sequence).toContain("add export");
    expect(sequence).toContain("add import");
    expect(sequence).toContain("push");
  });

  test("describe failure (describe throws) is treated as no existing entry", () => {
    // describe fails → exportAlreadyPresent = false → add export is attempted
    let addExportCalled = false;
    const runner = buildRunner({
      "describe account": () => fail("nsc describe: account not found"),
      "add export": () => { addExportCalled = true; return ok(); },
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

    expect(result.exportAlreadyPresent).toBe(false);
    expect(result.exportAdded).toBe(true);
    expect(addExportCalled).toBe(true);
  });
});
