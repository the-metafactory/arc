/**
 * xdg-migrate — #287 (P2) migration-on-touch for arc's OWN directories.
 *
 * When arc adopts the XDG base dirs for its own state (repos → `$XDG_DATA_HOME`,
 * cache → `$XDG_CACHE_HOME`, config/sources → `$XDG_CONFIG_HOME`), an existing
 * install's data is left at the legacy `~/.config/metafactory/…` locations. The
 * NEXT time the user runs ANY arc command, `migrateArcDirsIfNeeded` relocates it
 * — mirroring the proven `migrateConfigIfNeeded` pattern (existence-gated,
 * idempotent) but with two hardening rules the trust-lane demands:
 *
 *   1. COPY-KEEP-SOURCE. Legacy dirs are COPIED, never renamed/deleted, in this
 *      phase. If any later step (DB rewrite, relink) fails, the legacy tree is
 *      still fully intact and every legacy symlink still resolves — arc keeps
 *      working. A later prune wave removes the legacy copy once the new layout
 *      is proven; that is deliberately NOT done here.
 *
 *   2. THREE-PART REPOS LOCKSTEP. Moving the repos dir is not a file move — the
 *      cloned repos are the symlink targets AND the DB records absolute paths
 *      into them. So relocating repos means, in order:
 *        (a) copy the repos dir to the new data root (keep source);
 *        (b) rewrite packages.db path rows (install_path / skill_dir /
 *            customization_path) old→new, via the DB library layer in a
 *            transaction;
 *        (c) re-create every `~/.claude/{skills,agents,commands,bin}` symlink so
 *            it points at the NEW repo path.
 *      Because (a) keeps the source and (b)/(c) only ever re-point to the
 *      freshly-copied NEW tree (which is verified present), a partial/failed
 *      migration can never leave a dangling symlink: every symlink resolves to
 *      either the legacy tree (untouched) or the new tree (just copied).
 *
 * A completion marker (`.arc-xdg-migrated` under the new data root) is written
 * only after the whole sequence succeeds, so a fresh/relocated user pays one
 * pair of `existsSync` checks and an already-migrated user short-circuits. A run
 * that dies mid-way writes no marker and is retried (idempotently) next touch.
 */

import {
  existsSync,
  cpSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join, sep } from "path";
import { homedir } from "os";
import type { ArcPaths, HostAdapter } from "../types.js";
import type { PathSeam } from "./paths.js";
import { openDatabase, rewriteInstallPathPrefix } from "./db.js";

/** The subset of arc's dirs the #287 migration relocates. */
export interface ArcDirLayout {
  configRoot: string;
  dataRoot: string;
  reposDir: string;
  cachePath: string;
  dbPath: string;
  sourcesPath: string;
  secretsDir: string;
  runtimeDir: string;
  pipelinesDir: string;
  actionsDir: string;
}

/** Basename of the completion marker under the (new) data root. */
export const XDG_MIGRATION_MARKER = ".arc-xdg-migrated";

/**
 * The pre-#287 DEFAULT layout — everything under `~/.config/metafactory/…`.
 * This is the "legacy" side of the migration. Derived from the seam so tests
 * can point it at a scratch `$HOME` with zero real-home access.
 */
export function legacyArcLayout(seam?: PathSeam): ArcDirLayout {
  const home = seam?.home ?? homedir();
  const configRoot = join(home, ".config", "metafactory");
  return {
    configRoot,
    dataRoot: configRoot,
    reposDir: join(configRoot, "pkg", "repos"),
    cachePath: join(configRoot, "pkg", "cache"),
    dbPath: join(configRoot, "packages.db"),
    sourcesPath: join(configRoot, "sources.yaml"),
    secretsDir: join(configRoot, "secrets"),
    runtimeDir: join(configRoot, "skills"),
    pipelinesDir: join(configRoot, "pipelines"),
    actionsDir: join(configRoot, "actions"),
  };
}

/** Narrow `ArcPaths` (or a test bundle) to the `ArcDirLayout` shape. */
export function toArcDirLayout(p: ArcPaths | ArcDirLayout): ArcDirLayout {
  return {
    configRoot: p.configRoot,
    dataRoot: p.dataRoot,
    reposDir: p.reposDir,
    cachePath: p.cachePath,
    dbPath: p.dbPath,
    sourcesPath: p.sourcesPath,
    secretsDir: p.secretsDir,
    runtimeDir: p.runtimeDir,
    pipelinesDir: p.pipelinesDir,
    actionsDir: p.actionsDir,
  };
}

export interface XdgMigrationResult {
  /** Did any file/dir actually move (or a relink/rewrite happen)? */
  migrated: boolean;
  /** Human-readable reason when nothing was done. */
  skipped?: "already-complete" | "no-legacy" | "same-layout";
  /** Config-class children copied into the new config root. */
  configChildrenCopied: string[];
  /** Was the cache dir copied? */
  cacheCopied: boolean;
  /** Was the repos dir copied? */
  reposCopied: boolean;
  /** Was the db copied? */
  dbCopied: boolean;
  /** Number of packages.db rows re-rooted at the new repos path. */
  dbRowsRewritten: number;
  /** Number of host symlinks re-pointed at the new repos path. */
  symlinksRepointed: number;
  /** Non-fatal warnings (best-effort steps that failed). */
  warnings: string[];
}

/** Copy `src` → `dst` (recursive), keeping the source. No-op if `src` absent or
 *  `dst` already present (idempotent — never clobbers a partial prior run). */
function copyKeepSource(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  if (existsSync(dst)) return false;
  cpSync(src, dst, { recursive: true });
  return true;
}

/**
 * Copy a SQLite db file AND its WAL sidecars (`-wal` / `-shm`), keeping the
 * source. arc runs the db in WAL mode, so the newest rows can live in the
 * uncheckpointed `-wal` sidecar: copying only `packages.db` would silently drop
 * them (the same WAL trap the cortex data-move hit). Carrying the sidecars gives
 * the new location a byte-consistent copy that SQLite replays on open. No-op if
 * `srcDb` absent or `dstDb` already present.
 */
function copyDbKeepSource(srcDb: string, dstDb: string): boolean {
  if (!existsSync(srcDb)) return false;
  if (existsSync(dstDb)) return false;
  cpSync(srcDb, dstDb);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) cpSync(srcDb + suffix, dstDb + suffix);
  }
  return true;
}

/** Swap an exact-segment `oldPrefix` for `newPrefix` on `target`, else null. */
function swapPrefix(
  target: string,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  if (target === oldPrefix) return newPrefix;
  if (target.startsWith(oldPrefix + sep)) return newPrefix + target.slice(oldPrefix.length);
  return null;
}

/**
 * Walk `dir` (bounded depth) and re-point every symlink whose target lives
 * under `oldPrefix` at the corresponding path under `newPrefix`. Only re-points
 * TO the new tree (which the caller has already copied and verified present), so
 * it can never create a dangling link. Idempotent: a link already under
 * `newPrefix` is skipped. Returns the count re-pointed.
 */
function repointSymlinksUnder(
  dir: string,
  oldPrefix: string,
  newPrefix: string,
  warnings: string[],
  depth = 4,
): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    warnings.push(`relink: cannot read ${dir}: ${errMsg(err)}`);
    return 0;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(p);
      } catch {
        continue;
      }
      const swapped = swapPrefix(target, oldPrefix, newPrefix);
      if (swapped !== null) {
        try {
          unlinkSync(p);
          symlinkSync(swapped, p);
          count++;
        } catch (err) {
          // Surface but don't abort — legacy target still exists (copy-keep-
          // source), so the old link, if we failed before unlinking, still works.
          warnings.push(`relink: failed to re-point ${p}: ${errMsg(err)}`);
        }
      }
    } else if (st.isDirectory() && depth > 0) {
      count += repointSymlinksUnder(p, oldPrefix, newPrefix, warnings, depth - 1);
    }
  }
  return count;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Relocate arc's own dirs from `legacy` to `next` on first touch. See the file
 * header for the copy-keep-source + three-part-lockstep guarantees.
 *
 * Callers pass the resolved `next` layout (arc's actual `ArcPaths`) and the
 * `host` whose symlink dirs (`skills/agents/commands/bin`) must be re-pointed.
 * The CLI only calls this on the default layout (`isArcDefaultLayout`); when an
 * override or `ARC_CONFIG_ROOT` is set `next` equals `legacy` and this returns
 * `same-layout` without touching anything.
 */
export async function migrateArcDirsIfNeeded(opts: {
  legacy: ArcDirLayout;
  next: ArcDirLayout;
  host: HostAdapter;
  quiet?: boolean;
}): Promise<XdgMigrationResult> {
  const { legacy, next, host } = opts;
  const log = (m: string) => {
    if (!opts.quiet) console.log(m);
  };

  const result: XdgMigrationResult = {
    migrated: false,
    configChildrenCopied: [],
    cacheCopied: false,
    reposCopied: false,
    dbCopied: false,
    dbRowsRewritten: 0,
    symlinksRepointed: 0,
    warnings: [],
  };

  // Same layout (override / ARC_CONFIG_ROOT / equal paths) → nothing to do.
  if (legacy.reposDir === next.reposDir && legacy.configRoot === next.configRoot) {
    result.skipped = "same-layout";
    return result;
  }

  // Already migrated → short-circuit.
  const marker = join(next.dataRoot, XDG_MIGRATION_MARKER);
  if (existsSync(marker)) {
    result.skipped = "already-complete";
    return result;
  }

  // Nothing legacy present → fresh (or already-pruned) install, nothing to move.
  const legacyPresent =
    existsSync(legacy.reposDir) ||
    existsSync(legacy.dbPath) ||
    existsSync(legacy.sourcesPath) ||
    existsSync(legacy.secretsDir) ||
    existsSync(legacy.cachePath) ||
    existsSync(legacy.runtimeDir) ||
    existsSync(legacy.pipelinesDir) ||
    existsSync(legacy.actionsDir);
  if (!legacyPresent) {
    result.skipped = "no-legacy";
    return result;
  }

  try {
    // (1) Config-class children: sources.yaml + secrets/ + skills/ + pipelines/
    //     + actions/ move into the new config root (`…/metafactory/arc`).
    const configChildren: [string, string, string][] = [
      ["sources.yaml", legacy.sourcesPath, next.sourcesPath],
      ["secrets", legacy.secretsDir, next.secretsDir],
      ["skills", legacy.runtimeDir, next.runtimeDir],
      ["pipelines", legacy.pipelinesDir, next.pipelinesDir],
      ["actions", legacy.actionsDir, next.actionsDir],
    ];
    for (const [label, from, to] of configChildren) {
      if (from !== to && copyKeepSource(from, to)) {
        result.configChildrenCopied.push(label);
      }
    }

    // (2) Cache class: regenerable remote-registry index.
    if (legacy.cachePath !== next.cachePath && copyKeepSource(legacy.cachePath, next.cachePath)) {
      result.cacheCopied = true;
    }

    // (3) Data class + RELINK (the three-part lockstep).
    if (legacy.reposDir !== next.reposDir) {
      // (3a) copy the repos tree (keep source).
      result.reposCopied = copyKeepSource(legacy.reposDir, next.reposDir);
      // copy the db (with its WAL sidecars) alongside it.
      result.dbCopied = copyDbKeepSource(legacy.dbPath, next.dbPath);

      // (3b) rewrite packages.db path rows old→new, transactionally.
      if (existsSync(next.dbPath)) {
        const db = openDatabase(next.dbPath);
        try {
          result.dbRowsRewritten = rewriteInstallPathPrefix(db, legacy.reposDir, next.reposDir);
        } finally {
          db.close();
        }
      }

      // (3c) re-point every host symlink that targets the legacy repos tree.
      const hostDirs = [
        host.paths.skillsDir,
        host.paths.agentsDir,
        host.paths.promptsDir,
        host.paths.binDir,
      ];
      for (const dir of hostDirs) {
        result.symlinksRepointed += repointSymlinksUnder(
          dir,
          legacy.reposDir,
          next.reposDir,
          result.warnings,
        );
      }
    }

    result.migrated =
      result.configChildrenCopied.length > 0 ||
      result.cacheCopied ||
      result.reposCopied ||
      result.dbCopied ||
      result.dbRowsRewritten > 0 ||
      result.symlinksRepointed > 0;

    // Completion marker — only after the full sequence succeeded.
    writeFileSync(
      marker,
      `migrated from ${legacy.configRoot}\n` +
        `repos: ${legacy.reposDir} -> ${next.reposDir}\n`,
    );

    if (result.migrated) {
      log(
        `arc: migrated to XDG layout — ` +
          `${result.dbRowsRewritten} db row(s), ${result.symlinksRepointed} symlink(s) re-pointed; ` +
          `legacy tree kept at ${legacy.configRoot}`,
      );
    }
  } catch (err) {
    // No marker written → retried (idempotently) next touch. Legacy tree is
    // intact (copy-keep-source), so arc keeps working meanwhile.
    result.warnings.push(`migration aborted: ${errMsg(err)}`);
    if (!opts.quiet) {
      console.warn(
        `arc: XDG migration did not complete (${errMsg(err)}); ` +
          `legacy paths under ${legacy.configRoot} remain in use. Will retry next run.`,
      );
    }
  }

  return result;
}
