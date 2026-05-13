import { existsSync } from "fs";
import { mkdir, readFile, unlink } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type {
  ArcManifest,
  DarwinLaunchdHostPaths,
  HostAdapter,
} from "../../types.js";
import { createSymlink, removeSymlink } from "../symlinks.js";

/**
 * Token substitution map for plist rendering.
 *
 * The design doc (cortex `docs/design-arc-agent-bots.md` §3.2 / arc#140)
 * names a handful of well-known tokens that a bot package's plist
 * template can reference. arc resolves each token from environment +
 * computed defaults at install time. Unknown `{{TOKEN}}` markers are
 * passed through verbatim — a deliberately permissive policy so a bot
 * package can use its own custom tokens (handled by its own
 * lifecycle.postinstall script before launchctl bootstrap, or simply
 * left in the rendered file when launchd does not care).
 */
export type LaunchdTokens = Record<string, string>;

/**
 * Compute default token values used during plist rendering.
 *
 * - `{{BIN}}` → absolute path of `~/bin/<binary>` (after install)
 * - `{{INSTALL_PATH}}` → the cloned-package directory
 * - `{{HOME}}` → `os.homedir()`
 * - `{{LOG_DIR}}` → `~/Library/Logs/<package-name>/`
 * - `{{NATS_URL}}` → `process.env.NATS_URL` or `nats://127.0.0.1:4222`
 *
 * Callers may pass `extra` to override or extend.
 */
export function buildLaunchdTokens(opts: {
  installPath: string;
  packageName: string;
  binaryAbsPath?: string;
  extra?: LaunchdTokens;
}): LaunchdTokens {
  const home = homedir();
  const base: LaunchdTokens = {
    BIN: opts.binaryAbsPath ?? "",
    INSTALL_PATH: opts.installPath,
    HOME: home,
    LOG_DIR: join(home, "Library", "Logs", opts.packageName),
    NATS_URL: process.env.NATS_URL ?? "nats://127.0.0.1:4222",
  };
  return { ...base, ...(opts.extra ?? {}) };
}

/**
 * Render a plist template by substituting `{{TOKEN}}` markers.
 *
 * Permissive on unknown tokens: a `{{FOO}}` whose key is not in `tokens`
 * is preserved verbatim in the output. This lets a bot package use
 * custom markers that its own lifecycle script resolves before
 * `launchctl bootstrap`.
 *
 * The marker grammar accepts `[A-Za-z0-9_-]+` so hyphenated token names
 * (e.g. `{{LOG-DIR}}`, `{{ai-meta-factory}}`) substitute too. Sage P3
 * review (arc#143): the original `\w` class silently passed hyphenated
 * markers through unsubstituted even when present in the tokens map.
 */
export function renderPlist(template: string, tokens: LaunchdTokens): string {
  return template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (match, key: string) => {
    return key in tokens ? tokens[key] : match;
  });
}

/**
 * Aggregate of artifacts created by the darwin-launchd install pass.
 * Captured so the multi-target rollback (arc#140 P4) can reverse them
 * cleanly on a downstream failure.
 */
export interface LaunchdInstallRecord {
  /** Absolute path of `~/bin/<binary>` (symlink to the package binary). */
  binSymlink?: string;
  /** Absolute path of `~/Library/LaunchAgents/<label>.plist`. */
  plistPath?: string;
}

/**
 * Install the darwin-launchd-side artifacts of a `type: agent` package:
 * symlink `provides.binary` into `host.paths.binDir`, render
 * `provides.plist` into `host.paths.plistDir`. Does NOT invoke
 * `launchctl bootstrap` — that side effect lives in the bot's own
 * `lifecycle.postinstall` array per cortex `docs/design-arc-agent-bots.md`
 * §8.2 (ordering: cortex reload → issue creds → launchctl load LAST).
 *
 * Returns the record so a later failure can roll back the launchd side
 * of the multi-target install. arc#140 P3 returns the record; arc#140
 * P4 wires it into the full rollback path.
 */
export async function installLaunchdArtifacts(opts: {
  host: HostAdapter & { paths: DarwinLaunchdHostPaths };
  manifest: ArcManifest;
  installDir: string;
  /** Suppress console output (for non-interactive / test use). */
  quiet?: boolean;
  /** Extra token overrides for plist rendering (test isolation). */
  tokens?: LaunchdTokens;
}): Promise<LaunchdInstallRecord> {
  const record: LaunchdInstallRecord = {};
  const provides = opts.manifest.provides ?? {};

  // 1. Install the binary (symlink into host.binDir).
  if (provides.binary) {
    const sourceBinPath = join(opts.installDir, provides.binary);
    if (!existsSync(sourceBinPath)) {
      throw new Error(
        `provides.binary '${provides.binary}' does not exist in the package at ${sourceBinPath}`,
      );
    }
    // The binary's name in PATH is the basename of provides.binary —
    // a manifest declaring `binary: bin/sage` lands as `~/bin/sage`.
    const binName = provides.binary.split("/").pop()!;
    const binLinkPath = join(opts.host.paths.binDir, binName);
    await mkdir(opts.host.paths.binDir, { recursive: true });
    await createSymlink(sourceBinPath, binLinkPath);
    record.binSymlink = binLinkPath;
    if (!opts.quiet) {
      console.log(`  ✓ Binary linked: ${binLinkPath}`);
    }
  }

  // 2. Render the plist (token substitution) and write into plistDir.
  if (provides.plist) {
    const sourcePlistPath = join(opts.installDir, provides.plist);
    if (!existsSync(sourcePlistPath)) {
      throw new Error(
        `provides.plist '${provides.plist}' does not exist in the package at ${sourcePlistPath}`,
      );
    }
    const template = await readFile(sourcePlistPath, "utf-8");

    const tokens = buildLaunchdTokens({
      installPath: opts.installDir,
      packageName: opts.manifest.name,
      binaryAbsPath: record.binSymlink,
      extra: opts.tokens,
    });
    const rendered = renderPlist(template, tokens);

    // The plist filename lives in the manifest path's basename — a
    // manifest declaring `plist: services/ai.meta-factory.sage.plist`
    // lands as `~/Library/LaunchAgents/ai.meta-factory.sage.plist`.
    const plistName = provides.plist.split("/").pop()!;
    const plistTargetPath = join(opts.host.paths.plistDir, plistName);
    await mkdir(dirname(plistTargetPath), { recursive: true });
    await Bun.write(plistTargetPath, rendered);
    record.plistPath = plistTargetPath;
    if (!opts.quiet) {
      console.log(`  ✓ Plist rendered: ${plistTargetPath}`);
    }
  }

  return record;
}

/**
 * Reverse the launchd-side install at uninstall time (arc#140 P5).
 *
 * Symmetric to {@link installLaunchdArtifacts}: removes the binary
 * symlink from `host.binDir` and the rendered plist from `host.plistDir`.
 * Does NOT invoke `launchctl bootout` — that side effect lives in the
 * bot's own `lifecycle.preuninstall` array, which arc runs BEFORE this
 * function fires.
 *
 * Best-effort across both artifacts: ENOENT on either path is swallowed
 * (idempotent removal), non-ENOENT errors surface via console.warn so
 * the user sees orphans they need to inspect manually.
 *
 * Returns the paths actually removed (for caller-side diagnostics /
 * test assertions). Empty fields mean "already gone or never declared".
 */
export async function removeLaunchdArtifacts(opts: {
  host: HostAdapter & { paths: DarwinLaunchdHostPaths };
  manifest: ArcManifest;
  quiet?: boolean;
}): Promise<LaunchdInstallRecord> {
  const removed: LaunchdInstallRecord = {};
  const provides = opts.manifest.provides ?? {};

  if (provides.binary) {
    const binName = provides.binary.split("/").pop()!;
    const binLinkPath = join(opts.host.paths.binDir, binName);
    try {
      await unlink(binLinkPath);
      removed.binSymlink = binLinkPath;
      if (!opts.quiet) {
        console.log(`  ✓ Binary unlinked: ${binLinkPath}`);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(
          `  ⚠ remove: failed to unlink launchd binary ${binLinkPath}: ${err?.message ?? err}`,
        );
      }
    }
  }

  if (provides.plist) {
    const plistName = provides.plist.split("/").pop()!;
    const plistPath = join(opts.host.paths.plistDir, plistName);
    try {
      await unlink(plistPath);
      removed.plistPath = plistPath;
      if (!opts.quiet) {
        console.log(`  ✓ Plist removed: ${plistPath}`);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(
          `  ⚠ remove: failed to unlink launchd plist ${plistPath}: ${err?.message ?? err}`,
        );
      }
    }
  }

  return removed;
}

/**
 * Reverse {@link installLaunchdArtifacts}.
 *
 * Best-effort across both artifacts: an ENOENT on one path doesn't
 * abort cleanup of the other. Caller (arc#140 P4 rollback path)
 * surfaces non-ENOENT errors via console.warn so the user sees
 * orphans they need to inspect manually rather than failing silently.
 *
 * Does NOT invoke `launchctl bootout` — that side effect lives in the
 * bot's own `lifecycle.preuninstall` array (arc#140 P5).
 */
export async function rollbackLaunchdArtifacts(
  record: LaunchdInstallRecord,
): Promise<void> {
  if (record.binSymlink) {
    try {
      await removeSymlink(record.binSymlink);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(
          `  ⚠ rollback: failed to remove launchd binary symlink ${record.binSymlink}: ${err?.message ?? err}`,
        );
      }
    }
  }
  if (record.plistPath) {
    try {
      // Plist is a rendered file (not a symlink). Plain unlink.
      await unlink(record.plistPath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn(
          `  ⚠ rollback: failed to remove launchd plist ${record.plistPath}: ${err?.message ?? err}`,
        );
      }
    }
  }
}
