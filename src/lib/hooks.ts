/**
 * Hook registration for Claude Code settings.json.
 *
 * Manages the `hooks` section of ~/.claude/settings.json, allowing
 * arc packages to declaratively register event hooks. Each hook
 * entry is tagged with `_pai_pkg` for provenance tracking and clean removal.
 */

import { existsSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import type { HooksDeclaration, InlineHook, HooksConfigRef } from "../types.js";

/** A single hook entry in settings.json's hooks.<event> array */
interface SettingsHookGroup {
  _pai_pkg?: string;
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

/** The hooks section of settings.json */
interface SettingsHooks {
  [event: string]: SettingsHookGroup[];
}

/** Minimal settings.json structure (preserves unknown fields) */
interface Settings {
  hooks?: SettingsHooks;
  [key: string]: unknown;
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
 *    resolves any $PKG_DIR or $<NAME>_DIR env vars to the actual install path.
 *
 * Returns null if hooks is undefined (no hooks declared).
 */
export function resolveHooksFromManifest(
  hooks: HooksDeclaration | undefined,
  installPath: string,
  packageName: string,
): InlineHook[] | null {
  if (!hooks) return null;

  // Format 1: inline array — already in the right shape
  if (Array.isArray(hooks)) {
    return resolveCommandPaths(hooks, installPath, packageName);
  }

  // Format 2: config-file reference
  const configRef = hooks as HooksConfigRef;
  if (!configRef.claude_code?.config) return null;

  const configPath = join(installPath, configRef.claude_code.config);

  let configData: Record<string, Array<{ type?: string; command: string }>>;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
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

  return resolveCommandPaths(flattened, installPath, packageName);
}

/**
 * Replace $PKG_DIR / ${PKG_DIR} and $<NAME>_DIR / ${<NAME>_DIR}
 * in hook commands with the actual install path.
 */
function resolveCommandPaths(
  hooks: InlineHook[],
  installPath: string,
  packageName: string,
): InlineHook[] {
  const nameUpper = packageName.toUpperCase().replace(/-/g, "_");
  const namePattern = new RegExp(`\\$\\{?${nameUpper}_DIR\\}?`, "g");

  return hooks.map((hook) => ({
    ...hook,
    command: hook.command
      .replace(/\$\{?PKG_DIR\}?/g, installPath)
      .replace(namePattern, installPath),
  }));
}

/**
 * Inspect resolved hook commands and return any that reference an absolute
 * file path that does not exist on disk. A hook that points at a missing
 * file silently breaks every session (see issue #84), so install must refuse
 * to register such hooks.
 *
 * Heuristic: tokenize on whitespace, look at tokens starting with "/" or "~/".
 * Skip tokens that follow a shell redirect/pipe operator on the previous
 * token, since those are output sinks rather than required inputs.
 *
 * TODO: $HOME / ${HOME} (and other env-var references) are not substituted
 * upstream by resolveHooksFromManifest, so a hook using "$HOME/script.sh"
 * is left as the literal string and will not be inspected here. If/when the
 * resolver grows env-var substitution, drop the redundant ~/ branch below.
 */
export function findMissingHookFiles(
  hooks: InlineHook[],
): Array<{ event: string; command: string; missingPath: string }> {
  const issues: Array<{ event: string; command: string; missingPath: string }> = [];
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
      if (!stripped) continue;
      let path: string | null = null;
      if (stripped.startsWith("/")) {
        path = stripped;
      } else if (stripped.startsWith("~/")) {
        path = stripped.replace(/^~/, process.env.HOME ?? "");
      }
      if (!path) continue;
      if (!existsSync(path)) {
        issues.push({ event: hook.event, command: hook.command, missingPath: path });
      }
    }
  }
  return issues;
}

/**
 * Check whether a manifest has any hooks declared (either format).
 */
export function hasHooks(hooks: HooksDeclaration | undefined): boolean {
  if (!hooks) return false;
  if (Array.isArray(hooks)) return hooks.length > 0;
  return !!(hooks as HooksConfigRef).claude_code?.config;
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
  hooks: Array<{ event: string; command: string; matcher?: string }>,
  settingsPath: string,
): Promise<void> {
  const settings = await readSettings(settingsPath);

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const hook of hooks) {
    if (!settings.hooks[hook.event]) {
      settings.hooks[hook.event] = [];
    }

    const eventArray = settings.hooks[hook.event];

    // Check for duplicate: same package + same command
    const existing = eventArray.find(
      (entry) =>
        entry._pai_pkg === packageName &&
        entry.hooks.some((h) => h.command === hook.command),
    );

    if (existing) continue; // Already registered, skip

    const group: SettingsHookGroup = {
      _pai_pkg: packageName,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [{ type: "command", command: hook.command }],
    };

    eventArray.push(group);
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

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter(
      (entry) => entry._pai_pkg !== packageName,
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
): Array<{ event: string; command: string }> {
  if (!existsSync(settingsPath)) return [];

  let settings: Settings;
  try {
    const { readFileSync } = require("fs");
    const raw = readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw) as Settings;
  } catch {
    return [];
  }

  if (!settings.hooks) return [];

  const results: Array<{ event: string; command: string }> = [];

  for (const [event, entries] of Object.entries(settings.hooks)) {
    for (const entry of entries) {
      if (entry._pai_pkg === packageName) {
        for (const hook of entry.hooks) {
          results.push({ event, command: hook.command });
        }
      }
    }
  }

  return results;
}
