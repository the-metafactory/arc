/**
 * `arc files <name>` (arc#359) — dpkg -L for an installed package.
 *
 * Lists every artifact the package put on disk, grouped, each with a liveness
 * marker, PLUS the package's `owns:` purge-scope declarations. Read-only: it
 * never touches disk beyond stat. Gives testers the diffable inventory (what a
 * reset must account for) without a hand-maintained doc.
 *
 * Two audiences, one source of truth:
 *   - `formatFiles`     — human table.
 *   - `formatFilesJson` — machine-readable (`--json`).
 */

import { join } from "path";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { ArcManifest, ArcPaths, HostAdapter, InstalledSkill } from "../types.js";
import { getSkill } from "../lib/db.js";
import { readManifest } from "../lib/manifest.js";
import { extractAllCliInfo } from "../lib/symlinks.js";
import { resolveProvidesTarget } from "../lib/provides-target.js";
import { listPackageHooks } from "../lib/hooks.js";
import { resolveHost } from "../lib/hosts/registry.js";
import { isDarwinLaunchdHost } from "../lib/hosts/darwin-launchd.js";
import { isLinuxSystemdHost } from "../lib/hosts/linux-systemd.js";
import { basename } from "path";
import {
  OWNS_CLASSES,
  type OwnsClass,
  expandOwnsEntry,
  pathLiveness,
} from "../lib/owns.js";

/** Liveness of a filesystem artifact. */
export type Liveness = "present" | "absent";

/** One installed-artifact line. */
export interface FileArtifact {
  /** Group label: "artifact symlink", "cli shim", "bin symlink", "provides.files", "hook", "unit". */
  kind: string;
  /** The path (or, for a hook, a `settings.json` descriptor). */
  path: string;
  liveness: Liveness;
  /** Hook-only: the event the command is registered under. */
  event?: string;
}

/** One owns declaration + its resolved matches. */
export interface OwnsListing {
  class: OwnsClass;
  entry: string;
  /** "purge deletes" for config/state; "kept always" for userData. */
  disposition: "purge deletes" | "kept always";
  matches: { path: string; liveness: Liveness }[];
}

export interface FilesResult {
  name: string;
  installed: boolean;
  error?: string;
  artifacts: FileArtifact[];
  owns: OwnsListing[];
}

export interface FilesOptions {
  /** Home root for `~`-rooted owns expansion. Defaults to `homedir()`. Tests inject a temp home. */
  home?: string;
}

/**
 * Build the file inventory for an installed package. Errors cleanly (never
 * throws) when the package is not installed.
 */
export async function filesListing(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: FilesOptions = {},
): Promise<FilesResult> {
  const home = opts.home ?? homedir();
  const skill = getSkill(db, name);
  if (!skill) {
    return {
      name,
      installed: false,
      error: `'${name}' is not installed. Run \`arc list\` to see installed packages.`,
      artifacts: [],
      owns: [],
    };
  }

  const manifest = await readManifest(skill.install_path).catch(() => null);
  const artifacts: FileArtifact[] = [];

  // 1. Primary artifact symlink (type-conventional).
  for (const p of primaryArtifactPaths(skill, host, arc)) {
    artifacts.push({ kind: "artifact symlink", path: p, liveness: pathLiveness(p) });
  }

  // 2. CLI shims + bin symlinks.
  if (manifest) {
    for (const cli of extractAllCliInfo(manifest)) {
      const shim = join(arc.shimDir, cli.binName);
      const bin = join(host.paths.binDir, cli.binName);
      artifacts.push({ kind: "cli shim", path: shim, liveness: pathLiveness(shim) });
      artifacts.push({ kind: "bin symlink", path: bin, liveness: pathLiveness(bin) });
    }
  }

  // 3. provides.files targets.
  for (const f of manifest?.provides?.files ?? []) {
    const target = resolveProvidesTarget(f.target, { home });
    artifacts.push({ kind: "provides.files", path: target, liveness: pathLiveness(target) });
  }

  // 4. Per-target units / plists (standalone-bot agents).
  if (manifest) {
    for (const t of manifest.targets ?? []) {
      const unit = perTargetUnitPath(t, manifest);
      if (unit) artifacts.push({ kind: "unit", path: unit, liveness: pathLiveness(unit) });
    }
  }

  // 5. Hooks (settings.json, tag-keyed). Their presence IS the settings.json entry.
  for (const hook of listPackageHooks(name, host.paths.settingsPath)) {
    artifacts.push({
      kind: "hook",
      path: `${host.paths.settingsPath} :: ${hook.command}`,
      liveness: "present",
      event: hook.event,
    });
  }

  // 6. owns declarations (config/state deleted by purge; userData kept).
  const owns: OwnsListing[] = [];
  for (const cls of OWNS_CLASSES) {
    const entries = manifest?.owns?.[cls] ?? [];
    for (const entry of entries) {
      const matches = expandOwnsEntry(entry, home).map((path) => ({
        path,
        liveness: pathLiveness(path),
      }));
      owns.push({
        class: cls,
        entry,
        disposition: cls === "userData" ? "kept always" : "purge deletes",
        matches,
      });
    }
  }

  return { name, installed: true, artifacts, owns };
}

/** Type-conventional primary symlink path(s) — mirrors remove.ts dispatch. */
function primaryArtifactPaths(
  skill: InstalledSkill,
  host: HostAdapter,
  arc: ArcPaths,
): string[] {
  switch (skill.artifact_type) {
    case "agent":
      return [join(host.paths.agentsDir, `${skill.name}.md`), join(host.paths.agentsDir, skill.name)];
    case "prompt":
      return [join(host.paths.promptsDir, `${skill.name}.md`), join(host.paths.promptsDir, skill.name)];
    case "tool":
      return [join(host.paths.binDir, skill.name)];
    case "action":
      return [join(arc.actionsDir, skill.name)];
    case "pipeline":
      return [join(arc.pipelinesDir, skill.name)];
    default:
      return [join(host.paths.skillsDir, skill.name)];
  }
}

/** Resolve the unit/plist target path for a supervision target, if the manifest
 *  declares one. Returns null for non-supervision targets or when undeclared. */
function perTargetUnitPath(target: string, manifest: ArcManifest): string | null {
  if (target === "darwin-launchd" && manifest.provides?.plist) {
    const h = resolveHost(target);
    if (isDarwinLaunchdHost(h)) return join(h.paths.plistDir, basename(manifest.provides.plist));
  }
  if (target === "linux-systemd" && manifest.provides?.systemdUnit) {
    const h = resolveHost(target);
    if (isLinuxSystemdHost(h)) return join(h.paths.unitDir, basename(manifest.provides.systemdUnit));
  }
  return null;
}

const MARK = { present: "●", absent: "○" } as const;

/** Human-readable table. */
export function formatFiles(result: FilesResult): string {
  if (!result.installed) return `Error: ${result.error}`;

  const lines: string[] = [`Files for '${result.name}':`];

  if (result.artifacts.length === 0) {
    lines.push("  (no arc-installed artifacts on disk)");
  } else {
    lines.push("", "  Installed by arc (arc remove tears these down):");
    for (const a of result.artifacts) {
      const mark = MARK[a.liveness];
      const label = a.event ? `${a.kind} [${a.event}]` : a.kind;
      lines.push(`    ${mark} ${a.liveness.padEnd(7)} ${label.padEnd(16)} ${a.path}`);
    }
  }

  if (result.owns.length > 0) {
    lines.push("", "  Declared owns (runtime-created; arc purge acts on these):");
    for (const o of result.owns) {
      const tag = o.class === "userData" ? "(owns) kept always" : "(owns) purge deletes";
      lines.push(`    ${o.class}: ${o.entry}  — ${tag}`);
      if (o.matches.length === 0) {
        lines.push(`        ${MARK.absent} absent  (no match on disk)`);
      } else {
        for (const m of o.matches) {
          lines.push(`        ${MARK[m.liveness]} ${m.liveness.padEnd(7)} ${m.path}`);
        }
      }
    }
  }

  return lines.join("\n");
}

/** Machine-readable (`--json`). */
export function formatFilesJson(result: FilesResult): string {
  if (!result.installed) {
    return JSON.stringify({ name: result.name, installed: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      name: result.name,
      installed: true,
      artifacts: result.artifacts,
      owns: result.owns,
    },
    null,
    2,
  );
}
