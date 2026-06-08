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
