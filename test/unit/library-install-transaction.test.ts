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

  test("a removeDbRow failure mid-unwind does NOT abort rollback of the other artifacts", async () => {
    // arc#231 review (MAJOR): if removeSkill throws (SQLITE_BUSY / locked DB /
    // schema drift) on one artifact, every OTHER landed artifact must still get
    // its filesystem rollback and ROLLED_BACK journal state — the loop cannot
    // abort, or earlier-sequence artifacts are left with their symlinks behind.
    const filesystemRolledBack: string[] = [];
    const dbAttempts: string[] = [];

    const tx = beginLibraryInstallTransaction({
      libraryName: "dev-loop",
      removeDbRow: (name) => {
        dbAttempts.push(name);
        // Throw on the SECOND artifact unwound (pilot — landed[1], reverse).
        if (name === "pilot") {
          throw new Error("SQLITE_BUSY: database is locked");
        }
      },
    });

    // Three artifacts succeed (a, b=pilot, c). Reverse-unwind order: c, pilot, a.
    const names = ["a", "pilot", "c"];
    for (const name of names) {
      const sub = beginInstallTransaction({
        packageName: name,
        authorization: { approved: true },
      });
      const realRollback = sub.rollback.bind(sub);
      sub.rollback = async () => {
        filesystemRolledBack.push(name);
        return realRollback();
      };
      sub.recordDbCommit(name);
      tx.recordArtifactSuccess(name, sub);
    }

    tx.recordArtifactFailure("dev", "boom");

    // Must not throw despite removeDbRow throwing on 'pilot'.
    const journal = await tx.rollback();

    // ALL three got their filesystem rollback, in reverse order.
    expect(filesystemRolledBack).toEqual(["c", "pilot", "a"]);
    // The DB removal was ATTEMPTED for all three (the throw didn't skip any).
    expect(dbAttempts).toEqual(["c", "pilot", "a"]);

    // Every landed artifact is journaled ROLLED_BACK — even the one whose DB
    // row removal threw — so partial-state reporting stays truthful.
    const states = Object.fromEntries(
      journal.artifacts.map((a) => [a.name, a.state]),
    );
    expect(states.a).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states.pilot).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states.c).toBe(ArtifactInstallState.ROLLED_BACK);
    expect(states.dev).toBe(ArtifactInstallState.FAILED);
  });
});
