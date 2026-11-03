import { basename, dirname, isAbsolute, join, resolve } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { userHome } from "../user-home.js";
import { cortexConfigDirOverride, type CortexConfigDirSeam } from "./cortex-config-dir.js";

/**
 * The stack directory an installed cortex daemon loads, discovered from its
 * service descriptor (cortex#3134).
 *
 * A cortex daemon runs `cortex start --config <pointer>` and reads
 * `agents.d/` + `personas/` from `dirname(<pointer>)`. With no `--stack` or
 * `--config-dir`, arc used the config ROOT (`~/.config/metafactory/cortex` or
 * `~/.config/cortex`), which a config-split daemon never reads, so a bot pack
 * installed with a plain `arc install` was invisible to the running cortex.
 *
 * This scans the launchd plists (`~/Library/LaunchAgents/ai.meta-factory.cortex.*.plist`)
 * and systemd user units (`~/.config/systemd/user/*.service`) for a cortex
 * `start --config` argv, the same match cortex's own `daemon-locator.ts` uses.
 * One stack wins outright; with several, the stack named `default` (the stack
 * Pulse and the cortex CLI address by default) wins; otherwise the result is
 * `undefined` and the caller keeps its existing fallback. A descriptor whose
 * `--config` is relative, or names a file that no longer exists (a retired
 * stack), is skipped; systemd `%h` expands to the home dir. Whether the service
 * is currently LOADED is not checked. `$CORTEX_CONFIG_DIR` is an explicit root,
 * so it disables discovery.
 */
export function resolveLiveCortexStackDir(seam?: CortexConfigDirSeam): string | undefined {
  if (cortexConfigDirOverride(seam) !== undefined) return undefined;
  const home = seam?.home ?? userHome();
  const stacks = liveCortexStackDirs(home);
  if (stacks.length === 1) return stacks[0];
  return stacks.find((dir) => basename(dir) === "default");
}

/** Every distinct stack dir an installed cortex daemon service loads, sorted. */
export function liveCortexStackDirs(home: string): string[] {
  const dirs = new Set<string>();
  const launchAgents = join(home, "Library", "LaunchAgents");
  for (const text of readDescriptors(launchAgents, /^ai\.meta-factory\.cortex\..+\.plist$/)) {
    const dir = stackDirFromArgs(parsePlistProgramArguments(text), home);
    if (dir !== undefined) dirs.add(dir);
  }
  const systemdUser = join(home, ".config", "systemd", "user");
  for (const text of readDescriptors(systemdUser, /\.service$/)) {
    const dir = stackDirFromArgs(parseUnitExecStartArgs(text), home);
    if (dir !== undefined) dirs.add(dir);
  }
  return [...dirs].sort();
}

function readDescriptors(dir: string, namePattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const texts: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!namePattern.test(name)) continue;
    try {
      texts.push(readFileSync(join(dir, name), "utf-8"));
    } catch {
      continue;
    }
  }
  return texts;
}

function stackDirFromArgs(args: string[], home: string): string | undefined {
  const isCortexStart =
    args.some((a) => basename(a) === "cortex" || a.endsWith("/cortex/src/cli.ts")) && args.includes("start");
  if (!isCortexStart) return undefined;
  const config = configArgValue(args);
  if (config === undefined) return undefined;
  const expanded = config.startsWith("%h/")
    ? join(home, config.slice(3))
    : config === "~" ? home : config.startsWith("~/") ? join(home, config.slice(2)) : config;
  if (!isAbsolute(expanded) || !existsSync(expanded)) return undefined;
  return dirname(resolve(expanded));
}

function configArgValue(args: string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    const next = args.at(i + 1);
    if ((a === "-c" || a === "--config") && next !== undefined && next !== "") return next;
    const eq = /^--config=(.+)$/.exec(a);
    if (eq) return eq[1];
  }
  return undefined;
}

function parsePlistProgramArguments(xml: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (block === null) return [];
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

function parseUnitExecStartArgs(unitText: string): string[] {
  const line = unitText.split("\n").find((l) => /^\s*ExecStart\s*=/.test(l));
  if (line === undefined) return [];
  const value = line.slice(line.indexOf("=") + 1).trim();
  const prefix = /^([@\-+!:]+)/.exec(value)?.[1] ?? "";
  return value.slice(prefix.length).trim().split(/\s+/).filter((t) => t.length > 0);
}
