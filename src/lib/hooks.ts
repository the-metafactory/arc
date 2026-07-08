/**
 * Hook registration for Claude Code settings.json.
 *
 * Manages the `hooks` section of ~/.claude/settings.json, allowing
 * arc packages to declaratively register event hooks. Each hook
 * entry is tagged with `_arc_pkg` for provenance tracking and clean removal.
 *
 * Legacy compat (arc#276): arc was previously named "paipkg", and entries
 * written by older versions carry `_pai_pkg` instead. Every ownership check
 * below accepts EITHER tag, and `registerHooks`/`removeHooks` migrate a
 * package's legacy `_pai_pkg` entries to `_arc_pkg` in the same write that
 * touches settings.json for that package (no standalone migration command).
 */

import { existsSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { HooksDeclaration, InlineHook } from "../types.js";

/** A single hook entry in settings.json's hooks.<event> array */
interface SettingsHookGroup {
  _arc_pkg?: string;
  /** Legacy provenance tag from the "paipkg" era; read-compat only (arc#276). */
  _pai_pkg?: string;
  matcher?: string;
  hooks: { type: string; command: string }[];
}

/** The hooks section of settings.json */
type SettingsHooks = Record<string, SettingsHookGroup[]>;

/** Minimal settings.json structure (preserves unknown fields) */
interface Settings {
  hooks?: SettingsHooks;
  [key: string]: unknown;
}

function matcherKey(matcher: string | undefined): string {
  return matcher ?? "";
}

function hookGroupHasCommand(entry: SettingsHookGroup, command: string): boolean {
  return entry.hooks.some((hook) => hook.command === command);
}

/**
 * True when `entry` is tagged as belonging to `packageName`, under EITHER
 * the current `_arc_pkg` tag or the legacy `_pai_pkg` tag (arc#276).
 */
function isOwnedBy(entry: SettingsHookGroup, packageName: string): boolean {
  return entry._arc_pkg === packageName || entry._pai_pkg === packageName;
}

/** True when `entry` carries neither provenance tag (unclaimed). */
function isUntagged(entry: SettingsHookGroup): boolean {
  return entry._arc_pkg === undefined && entry._pai_pkg === undefined;
}

function shouldReplaceHookGroup(
  packageName: string,
  hook: { command: string; matcher?: string },
  entry: SettingsHookGroup,
): boolean {
  if (matcherKey(entry.matcher) !== matcherKey(hook.matcher)) return false;
  if (!hookGroupHasCommand(entry, hook.command)) return false;

  // Preserves the pre-#276 semantics exactly: an entry with no provenance
  // tag at all (neither _arc_pkg nor _pai_pkg) is still claimable.
  return isOwnedBy(entry, packageName) || isUntagged(entry);
}

/**
 * Rewrite any of `packageName`'s legacy `_pai_pkg` tags to `_arc_pkg`,
 * across every event in settings.hooks. Called by registerHooks /
 * removeHooks so a package's tags get migrated the next time arc touches
 * settings.json for it, without a standalone migration command (arc#276).
 */
function migrateLegacyTags(settings: Settings, packageName: string): void {
  if (!settings.hooks) return;
  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) {
      if (entry._pai_pkg === packageName) {
        entry._arc_pkg ??= packageName;
        delete entry._pai_pkg;
      }
    }
  }
}

/**
 * Read settings.json, returning empty object if it doesn't exist.
 */
async function readSettings(settingsPath: string): Promise<Settings> {
  if (!existsSync(settingsPath)) return {};
  try {
    const text = await Bun.file(settingsPath).text();
    return JSON.parse(text) as Settings;
  } catch {
    return {};
  }
}

/**
 * Write settings.json with 4-space indentation.
 */
async function writeSettings(
  settingsPath: string,
  settings: Settings,
): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await Bun.write(settingsPath, JSON.stringify(settings, null, 4) + "\n");
}

/**
 * Resolve hooks from a manifest's provides.hooks field.
 *
 * Supports two formats:
 * 1. Inline array: [{ event, command, matcher? }] — used directly
 * 2. Config-file ref: { claude_code: { config: "path/to/hooks.json" } } — loads
 *    the JSON file, flattens its { EventName: [{ command }] } structure, and
 *    resolves any $PKG_DIR / $<NAME>_DIR / $PAI_DIR env vars in commands.
 *
 * `paiDir` (when provided) is the absolute path expanded for `$PAI_DIR` /
 * `${PAI_DIR}` references — typically `paths.claudeRoot` (`~/.claude`). The
 * shape `${PAI_DIR}/hooks/handlers/Foo.ts` is the canonical way packages
 * point at hook handlers in this ecosystem; substituting it at resolve time
 * ensures install-time gating (#84) and `arc verify` hook-path validation
 * (#85) both stat the same absolute path the runtime would.
 *
 * Returns null if hooks is undefined (no hooks declared).
 */
export function resolveHooksFromManifest(
  hooks: HooksDeclaration | undefined,
  installPath: string,
  packageName: string,
  paiDir?: string,
): InlineHook[] | null {
  if (!hooks) return null;

  // Format 1: inline array — already in the right shape
  if (Array.isArray(hooks)) {
    return resolveCommandPaths(hooks, installPath, packageName, paiDir);
  }

  // Format 2: config-file reference
  const configRef = hooks;
  if (!configRef.claude_code.config) return null;

  const configPath = join(installPath, configRef.claude_code.config);

  interface HookEntry { type?: string; command: string }
  type HookMap = Record<string, HookEntry[]>;
  let configData: HookMap;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { hooks?: HookMap } & HookMap;
    // The JSON file has either { hooks: { Event: [...] } } or { Event: [...] }
    configData = parsed.hooks ?? parsed;
  } catch {
    return null;
  }

  // Flatten { SessionStart: [{ command }], PostToolUse: [{ command }] }
  // into [{ event: "SessionStart", command }, { event: "PostToolUse", command }]
  const flattened: InlineHook[] = [];
  for (const [event, entries] of Object.entries(configData)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.command) {
        flattened.push({ event, command: entry.command });
      }
    }
  }

  return resolveCommandPaths(flattened, installPath, packageName, paiDir);
}

/**
 * Replace $PKG_DIR / ${PKG_DIR}, $<NAME>_DIR / ${<NAME>_DIR},
 * (when provided) $PAI_DIR / ${PAI_DIR}, $HOME / ${HOME}, and a leading "~/"
 * in hook commands with the corresponding absolute paths.
 *
 * $HOME and ~/ are substituted at install time so the missing-file gate
 * (findMissingHookFiles) can stat the resolved absolute path, and so
 * settings.json stores the same absolute path the runtime would resolve
 * to — matching the existing $PKG_DIR / $PAI_DIR pattern. Without this,
 * "$HOME/script.sh" was left literal and slipped past the gate (#90).
 */
function resolveCommandPaths(
  hooks: InlineHook[],
  installPath: string,
  packageName: string,
  paiDir?: string,
): InlineHook[] {
  const nameUpper = packageName.toUpperCase().replace(/-/g, "_");
  const namePattern = new RegExp(`\\$\\{?${nameUpper}_DIR\\}?`, "g");
  const home = process.env.HOME ?? homedir();

  return hooks.map((hook) => {
    let command = hook.command
      .replace(/\$\{?PKG_DIR\}?/g, installPath)
      .replace(namePattern, installPath);
    if (paiDir) {
      command = command.replace(/\$\{?PAI_DIR\}?/g, paiDir);
    }
    // $HOME / ${HOME} → absolute home path
    command = command.replace(/\$\{?HOME\}?/g, home);
    // Leading "~/" or whitespace-preceded " ~/" → absolute home path. Bare "~"
    // alone (without a trailing slash) is left as-is to avoid mangling tokens
    // like "rsync@host:~" that legitimately use the literal character.
    command = command
      .replace(/^~\//, `${home}/`)
      .replace(/(\s)~\//g, `$1${home}/`);
    return { ...hook, command };
  });
}

/**
 * Inspect resolved hook commands and return any that reference an absolute
 * file path that does not exist on disk. A hook that points at a missing
 * file silently breaks every session (see issue #84), so install must refuse
 * to register such hooks.
 *
 * Heuristic: tokenize on whitespace, look at tokens starting with "/" (any
 * absolute path). $PKG_DIR / $<NAME>_DIR / $PAI_DIR / $HOME / leading "~/"
 * are all substituted upstream by resolveCommandPaths, so by the time a
 * hook command reaches this function the path-bearing tokens are already
 * absolute. Skip tokens that follow a shell redirect/pipe operator on the
 * previous token, since those are output sinks rather than required inputs.
 */
export function findMissingHookFiles(
  hooks: InlineHook[],
): { event: string; command: string; missingPath: string }[] {
  const issues: { event: string; command: string; missingPath: string }[] = [];
  // Tokens that direct shell I/O — the next path-like token is an output
  // destination, not a required file. ">>" / "<<" are caught by .startsWith.
  const REDIRECT_OPS = new Set([">", ">>", "<", "<<", "|", "&>", "2>", "2>>", "1>"]);
  for (const hook of hooks) {
    const tokens = hook.command.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const prev = i > 0 ? tokens[i - 1] : "";
      if (REDIRECT_OPS.has(prev) || prev.startsWith(">") || prev.startsWith("2>")) {
        continue;
      }
      const stripped = tokens[i].replace(/^['"]|['"]$/g, "");
      if (!stripped.startsWith("/")) continue;
      if (!existsSync(stripped)) {
        issues.push({ event: hook.event, command: hook.command, missingPath: stripped });
      }
    }
  }
  return issues;
}

/**
 * Register package hooks into ~/.claude/settings.json.
 *
 * Reads current settings, merges hook entries, writes back.
 * Each hook entry is tagged with the package name for clean removal.
 * Deduplicates by checking if the exact command already exists for this package.
 */
export async function registerHooks(
  packageName: string,
  hooks: { event: string; command: string; matcher?: string }[],
  settingsPath: string,
): Promise<void> {
  const settings = await readSettings(settingsPath);

  settings.hooks ??= {};

  // Migrate this package's legacy _pai_pkg tags to _arc_pkg before touching
  // anything else, so any pre-existing entries this package doesn't
  // currently declare hooks for (e.g. dropped in a later manifest version)
  // still get their provenance tag updated on this write (arc#276).
  migrateLegacyTags(settings, packageName);

  for (const hook of hooks) {
    // Record<string, T> indexing is typed as always-defined without
    // noUncheckedIndexedAccess; the runtime check is still needed.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!settings.hooks[hook.event]) {
      settings.hooks[hook.event] = [];
    }

    settings.hooks[hook.event] = settings.hooks[hook.event].filter(
      (entry) => !shouldReplaceHookGroup(packageName, hook, entry),
    );

    const group: SettingsHookGroup = {
      _arc_pkg: packageName,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [{ type: "command", command: hook.command }],
    };

    settings.hooks[hook.event].push(group);
  }

  await writeSettings(settingsPath, settings);
}

/**
 * Remove all hooks registered by a specific package from settings.json.
 */
export async function removeHooks(
  packageName: string,
  settingsPath: string,
): Promise<void> {
  const settings = await readSettings(settingsPath);

  if (!settings.hooks) return;

  // Migrate any surviving legacy tags for this package first (defensive;
  // entries actually owned by packageName are removed below regardless of
  // which tag they carry — see isOwnedBy — so this mainly keeps behavior
  // consistent with registerHooks' migrate-on-touch policy, arc#276).
  migrateLegacyTags(settings, packageName);

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter(
      (entry) => !isOwnedBy(entry, packageName),
    );
  }

  await writeSettings(settingsPath, settings);
}

/**
 * List hooks registered by a specific package.
 * Returns an array of { event, command } pairs.
 */
export function listPackageHooks(
  packageName: string,
  settingsPath: string,
): { event: string; command: string }[] {
  if (!existsSync(settingsPath)) return [];

  let settings: Settings;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw) as Settings;
  } catch {
    return [];
  }

  if (!settings.hooks) return [];

  const results: { event: string; command: string }[] = [];

  for (const [event, entries] of Object.entries(settings.hooks)) {
    for (const entry of entries) {
      if (isOwnedBy(entry, packageName)) {
        for (const hook of entry.hooks) {
          results.push({ event, command: hook.command });
        }
      }
    }
  }

  return results;
}
