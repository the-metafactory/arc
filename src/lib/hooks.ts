/**
 * Hook registration for Claude Code settings.json.
 *
 * Manages the `hooks` section of ~/.claude/settings.json, allowing
 * pai-pkg packages to declaratively register event hooks. Each hook
 * entry is tagged with `_pai_pkg` for provenance tracking and clean removal.
 */

import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";

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
