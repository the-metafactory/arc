import { describe, expect, test } from "bun:test";
import {
  beginInstallTransaction,
  beginLibraryInstallTransaction,
} from "../../src/lib/install-transaction.js";
import { ArtifactInstallState } from "../../src/types.js";

/**
 * A library-install transaction tracks an ORDERED sequence of artifact
 * sub-transactions and, on failure, rolls them back in REVERSE order — the
 * arc#140 P4 single-package rollback model lifted to the library level
 * (arc#227 / F-6c).
 */
describe("LibraryInstallTransaction", () => {
  test("journal starts with every artifact pending", () => {
    const tx = beginLibraryInstallTransaction({ libraryName: "dev-loop" });
    const journal = tx.journal();
    expect(journal.libraryName).toBe("dev-loop");
    expect(journal.artifacts).toEqual([]);
    expect(typeof journal.startedAt).toBe("string");
  });

  test("records skip / success / failure states per artifact", () => {
    const tx = beginLibraryInstallTransaction({ libraryName: "dev-loop" });

    tx.recordArtifactSkipped("agent-state");

    const okTx = beginInstallTransaction({
      packageName: "pilot",
      authorization: { approved: true },
    });
    okTx.recordDbCommit("pilot");
    tx.recordArtifactSuccess("pilot", okTx);

    tx.recordArtifactFailure("dev", "postinstall exited 1");

    const journal = tx.journal();
    expect(journal.artifacts.map((a) => [a.name, a.state])).toEqual([
      ["agent-state", ArtifactInstallState.SKIPPED],
      ["pilot", ArtifactInstallState.SUCCESS],
      ["dev", ArtifactInstallState.FAILED],
    ]);
    expect(journal.artifacts[2].error).toBe("postinstall exited 1");
  });

  test("rollback unwinds successful artifacts in reverse order and removes DB rows", async () => {
    const order: string[] = [];

    const tx = beginLibraryInstallTransaction({
      libraryName: "dev-loop",
      // The library tx delegates DB-row teardown to this callback so it does
      // not have to import the db module (keeps the transaction pure).
      removeDbRow: (name) => {
        order.push(`db:${name}`);
      },
    });

    // Two artifacts succeed; each owns a single-package sub-transaction whose
    // rollback we observe via a recorded extension (rollback is async + real).
    const first = beginInstallTransaction({
      packageName: "agent-state",
      authorization: { approved: true },
    });
    const firstRollback = first.rollback.bind(first);
    first.rollback = async () => {
      order.push("rollback:agent-state");
      return firstRollback();
    };
    first.recordDbCommit("agent-state");
    tx.recordArtifactSuccess("agent-state", first);

    const second = beginInstallTransaction({
      packageName: "pilot",
      authorization: { approved: true },
    });
    const secondRollback = second.rollback.bind(second);
    second.rollback = async () => {
      order.push("rollback:pilot");
      return secondRollback();
    };
    second.recordDbCommit("pilot");
    tx.recordArtifactSuccess("pilot", second);

    // Third artifact fails.
    tx.recordArtifactFailure("dev", "broker unreachable");

    const journal = await tx.rollback();

    // Reverse order: pilot rolled back before agent-state; DB rows removed too.
    expect(order).toEqual([
      "rollback:pilot",
      "db:pilot",
      "rollback:agent-state",
      "db:agent-state",
    ]);

    // Journal reflects the rolled-back state for the two that had landed.
    const states = Object.fromEntries(
      journal.artifacts.map((a) => [a.name, a.state]),
    );
    expect(states.pilot).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states["agent-state"]).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states.dev).toBe(ArtifactInstallState.FAILED);
  });

  test("skipped artifacts are NOT rolled back (they predate this install)", async () => {
    const removed: string[] = [];
    const tx = beginLibraryInstallTransaction({
      libraryName: "dev-loop",
      removeDbRow: (name) => removed.push(name),
    });

    tx.recordArtifactSkipped("agent-state"); // already installed before this run

    tx.recordArtifactFailure("pilot", "boom");

    await tx.rollback();

    // agent-state was pre-existing — rollback must not touch its DB row.
    expect(removed).toEqual([]);
    const journal = tx.journal();
    const skipped = journal.artifacts.find((a) => a.name === "agent-state");
    expect(skipped?.state).toBe(ArtifactInstallState.SKIPPED);
  });
});
