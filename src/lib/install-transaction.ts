import type { ArtifactSymlinkRecord } from "./artifact-installer.js";
import { rollbackArtifactSymlinks } from "./artifact-installer.js";
import type { LaunchdInstallRecord } from "./hosts/launchd-install.js";
import { rollbackLaunchdArtifacts } from "./hosts/launchd-install.js";
import { removeHooks } from "./hooks.js";
import { errorMessage } from "./errors.js";
import { rollbackWiredExtensions } from "./extensions.js";

export interface InstallAuthorization {
  approved: boolean;
}

export type LandedArtifact =
  | { kind: "symlink"; path: string }
  | { kind: "shim"; dir: string; name: string }
  | { kind: "hook"; settingsPath: string; count: number }
  | { kind: "extension"; name: string }
  | { kind: "launchd"; plistPath?: string; binSymlink?: string }
  | { kind: "db-row"; name: string };

export interface InstallTransactionEvidence {
  packageName: string;
  landedArtifacts: LandedArtifact[];
  dbCommitted: boolean;
  rollback: {
    attempted: boolean;
    warnings: string[];
  };
}

export interface InstallTransaction {
  readonly evidence: InstallTransactionEvidence;
  recordSymlinks(record: ArtifactSymlinkRecord): void;
  recordLaunchd(records: LaunchdInstallRecord[]): void;
  recordHookRegistration(settingsPath: string, count: number): void;
  recordExtensions(names: string[], claudeRoot: string): void;
  recordDbCommit(name: string): void;
  rollback(): Promise<InstallTransactionEvidence>;
}

// ── Library (multi-artifact) install transaction (arc#227 / F-6c) ───────────
//
// The single-package InstallTransaction above (arc#140 P4 lineage) tracks ONE
// artifact's landed state and unwinds it on failure. A `type: library` install
// lands an ORDERED SEQUENCE of artifacts; if artifact N fails, artifacts 1..N-1
// — which have already committed their DB rows + symlinks + hooks + launchd —
// must be unwound in REVERSE order to leave the stack in a known-good state.
//
// beginLibraryInstallTransaction is that lift: it holds each successful
// artifact's live sub-transaction handle (so rollback reuses the exact same
// rollback path, not a re-derived one) plus a `removeDbRow` callback for the
// committed DB rows the sub-transaction itself does not undo (the DB commit is
// the last step of a single-artifact install, so single-artifact rollback never
// needs it — the library level does).

/** Per-artifact outcome within a library install (arc#227 / F-6c). */
export enum ArtifactInstallState {
  /** Already installed before this run; left untouched. */
  SKIPPED = "skipped",
  /** Installed cleanly in this run. */
  SUCCESS = "success",
  /** Install attempt failed — the sequence stops here. */
  FAILED = "failed",
  /** Installed in this run, then unwound because a later artifact failed. */
  ROLLED_BACK = "rolled_back",
}

/** Reported per-artifact state for a library install (extends InstallResult). */
export interface ArtifactInstallDetail {
  name: string;
  version?: string;
  type?: string;
  state: ArtifactInstallState;
  /** Failure reason when state === FAILED. */
  error?: string;
  /** Landed-artifact evidence captured for SUCCESS / ROLLED_BACK entries. */
  evidence?: InstallTransactionEvidence;
}

/** Full transactional journal of a library install (arc#227 / F-6c). */
export interface LibraryInstallJournal {
  libraryName: string;
  artifacts: ArtifactInstallDetail[];
  /** ISO timestamp the library transaction opened. */
  startedAt: string;
}

export interface LibraryInstallTransaction {
  /** Record an artifact that was already installed (pre-existing — not unwound). */
  recordArtifactSkipped(name: string, version?: string, type?: string): void;
  /** Record a successful artifact install, capturing its live sub-transaction. */
  recordArtifactSuccess(
    name: string,
    tx: InstallTransaction,
    version?: string,
    type?: string,
  ): void;
  /** Record the failing artifact; the sequence stops and rollback follows. */
  recordArtifactFailure(name: string, error: string, version?: string, type?: string): void;
  /** Unwind every SUCCESS artifact in reverse order (symlinks/hooks/launchd + DB row). */
  rollback(): Promise<LibraryInstallJournal>;
  /** Snapshot of the journal as it currently stands. */
  journal(): LibraryInstallJournal;
}

export function beginLibraryInstallTransaction(opts: {
  libraryName: string;
  /**
   * Teardown callback for a committed DB row. Injected (rather than importing
   * the db module) so this transaction stays a pure unit. install.ts passes a
   * closure over `removeSkill(db, name)`.
   */
  removeDbRow?: (name: string) => void;
}): LibraryInstallTransaction {
  const startedAt = new Date().toISOString();

  // Ordered details, mirrored by the live sub-transaction handles for the
  // SUCCESS entries (parallel arrays keyed by insertion order).
  const details: ArtifactInstallDetail[] = [];
  const landed: { name: string; tx: InstallTransaction }[] = [];

  const find = (name: string) => details.find((d) => d.name === name);

  return {
    recordArtifactSkipped(name, version, type) {
      details.push({ name, version, type, state: ArtifactInstallState.SKIPPED });
    },

    recordArtifactSuccess(name, tx, version, type) {
      details.push({
        name,
        version,
        type,
        state: ArtifactInstallState.SUCCESS,
        evidence: tx.evidence,
      });
      landed.push({ name, tx });
    },

    recordArtifactFailure(name, error, version, type) {
      details.push({ name, version, type, state: ArtifactInstallState.FAILED, error });
    },

    async rollback() {
      // Reverse order: last landed artifact unwinds first.
      for (let i = landed.length - 1; i >= 0; i--) {
        const { name, tx } = landed[i];
        await tx.rollback();
        // The sub-transaction's own rollback does NOT remove the committed DB
        // row (the DB commit is the last step of a single-artifact install, so
        // it never had to). The library level removes it here.
        if (opts.removeDbRow) {
          opts.removeDbRow(name);
        }
        const detail = find(name);
        if (detail) {
          detail.state = ArtifactInstallState.ROLLED_BACK;
          detail.evidence = tx.evidence;
        }
      }
      return { libraryName: opts.libraryName, artifacts: details, startedAt };
    },

    journal() {
      return { libraryName: opts.libraryName, artifacts: details, startedAt };
    },
  };
}

export function beginInstallTransaction(opts: {
  packageName: string;
  authorization: InstallAuthorization;
}): InstallTransaction {
  if (!opts.authorization.approved) {
    throw new Error("Install Transaction requires Install Authorization");
  }

  const symlinkRecords: ArtifactSymlinkRecord[] = [];
  const launchdRecords: LaunchdInstallRecord[] = [];
  const hookRegistrations: { settingsPath: string; packageName: string }[] = [];
  const extensionRecords: { names: string[]; claudeRoot: string }[] = [];
  const evidence: InstallTransactionEvidence = {
    packageName: opts.packageName,
    landedArtifacts: [],
    dbCommitted: false,
    rollback: {
      attempted: false,
      warnings: [],
    },
  };

  const warn = (message: string) => {
    evidence.rollback.warnings.push(message);
  };

  return {
    evidence,

    recordSymlinks(record) {
      symlinkRecords.push(record);
      for (const path of record.symlinks) {
        evidence.landedArtifacts.push({ kind: "symlink", path });
      }
      for (const name of record.shims.names) {
        evidence.landedArtifacts.push({ kind: "shim", dir: record.shims.dir, name });
      }
    },

    recordLaunchd(records) {
      launchdRecords.push(...records);
      for (const record of records) {
        evidence.landedArtifacts.push({
          kind: "launchd",
          plistPath: record.plistPath,
          binSymlink: record.binSymlink,
        });
      }
    },

    recordHookRegistration(settingsPath, count) {
      hookRegistrations.push({ settingsPath, packageName: opts.packageName });
      evidence.landedArtifacts.push({ kind: "hook", settingsPath, count });
    },

    recordExtensions(names, claudeRoot) {
      extensionRecords.push({ names, claudeRoot });
      for (const name of names) {
        evidence.landedArtifacts.push({ kind: "extension", name });
      }
    },

    recordDbCommit(name) {
      evidence.dbCommitted = true;
      evidence.landedArtifacts.push({ kind: "db-row", name });
    },

    async rollback() {
      evidence.rollback.attempted = true;
      for (const hook of hookRegistrations) {
        try {
          await removeHooks(hook.packageName, hook.settingsPath);
        } catch (err) {
          warn(`failed to remove hooks from ${hook.settingsPath}: ${errorMessage(err)}`);
        }
      }
      for (const record of extensionRecords) {
        try {
          const warnings = await rollbackWiredExtensions(record.names, record.claudeRoot);
          for (const warning of warnings) {
            warn(warning);
          }
        } catch (err) {
          warn(`failed to roll back extensions: ${errorMessage(err)}`);
        }
      }
      for (const record of symlinkRecords) {
        try {
          await rollbackArtifactSymlinks(record);
        } catch (err) {
          warn(`failed to roll back symlinks: ${errorMessage(err)}`);
        }
      }
      for (const record of launchdRecords) {
        try {
          await rollbackLaunchdArtifacts(record);
        } catch (err) {
          warn(`failed to roll back launchd artifacts: ${errorMessage(err)}`);
        }
      }
      return evidence;
    },
  };
}
