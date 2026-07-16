import { join, relative, basename } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import type { Database } from "bun:sqlite";
import type { ArcPaths, HostAdapter, LinuxSystemdHostPaths } from "../types.js";
import { getSkill, listSkills } from "../lib/db.js";
import { isValidSymlink } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";
import { listPackageHooks, findMissingHookFiles } from "../lib/hooks.js";
import { resolveHost, type HostOverrides } from "../lib/hosts/registry.js";

export interface VerifyCheck {
  check: string;
  passed: boolean;
  detail?: string;
}

export interface VerifyResult {
  name: string;
  checks: VerifyCheck[];
  allPassed: boolean;
  error?: string;
}

/**
 * Verify integrity of an installed skill.
 */
/**
 * Verify integrity of an installed skill.
 *
 * @param arc Unused until Phase 3c, which adds arc-state checks (db row /
 *   manifest cross-reference, sources.yaml integrity). Kept in the
 *   signature now so that pass doesn't churn every call site twice.
 * @param hostOverrides Per-host adapter overrides (arc#311 — test
 *   isolation for the linux-systemd orphaned-unit check below, mirrors
 *   `InstallOptions.hostOverrides`). Production leaves this absent.
 */
export async function verify(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  hostOverrides?: HostOverrides,
): Promise<VerifyResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return {
      name,
      checks: [],
      allPassed: false,
      error: `Skill '${name}' is not installed`,
    };
  }

  const checks: VerifyCheck[] = [];

  // Check 1: Repo directory exists
  const repoExists = existsSync(skill.install_path);
  checks.push({
    check: "Repo directory exists",
    passed: repoExists,
    detail: skill.install_path,
  });

  // Check 2: arc-manifest.yaml exists
  const manifest = await readManifest(skill.install_path);
  checks.push({
    check: "arc-manifest.yaml valid",
    passed: manifest !== null,
  });

  // Check 3: Skill symlink valid (only for active skills)
  if (skill.status === "active") {
    const skillLink = join(host.paths.skillsDir, name);
    const linkValid = await isValidSymlink(skillLink);
    checks.push({
      check: "Skill symlink valid",
      passed: linkValid,
      detail: skillLink,
    });
  }

  // Check 4: Git repo clean
  if (repoExists) {
    const result = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: skill.install_path,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Filter out expected untracked files from bun install
    const ignored = /^(\?\? |..)?(node_modules\/|bun\.lock|\.DS_Store)$/;
    const dirtyLines = result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l && !ignored.test(l));
    const isClean = dirtyLines.length === 0;
    checks.push({
      check: "Git repo clean",
      passed: isClean,
      detail: isClean ? undefined : "Uncommitted changes detected",
    });
  }

  // Check 5: Hook command paths in settings.json resolve.
  // Issue #85: arc verify previously only checked the repo checkout, not the
  // covenant settings.json expresses ("this command path is runnable"). A
  // package whose installer registered hooks pointing at files that were
  // never placed (see #84) would still pass verify. Walk the package's hooks
  // from settings.json and stat each absolute path token.
  const registeredHooks = listPackageHooks(name, host.paths.settingsPath);
  if (registeredHooks.length) {
    const missing = findMissingHookFiles(registeredHooks);
    if (missing.length === 0) {
      checks.push({
        check: `Hook command paths resolve (${registeredHooks.length} registered)`,
        passed: true,
      });
    } else {
      // For each missing path, hint whether the file exists under the
      // package's repo dir — if so, the manifest probably needs a
      // provides.files entry rather than a raw hook command pointing
      // at an un-symlinked location.
      const detailLines = missing.map((m) => {
        const hint = repoExists ? hintFromRepo(skill.install_path, m.missingPath) : "";
        return `${m.event}: ${m.command}\n      missing: ${m.missingPath}${hint}`;
      });
      checks.push({
        check: `Hook command paths resolve (${registeredHooks.length} registered)`,
        passed: false,
        detail: detailLines.join("\n    "),
      });
    }
  }

  // Check 6: no orphaned systemd units (arc#311). Scoped to packages that
  // declare a linux-systemd target -- a plain skill/tool's verify doesn't
  // pay for a unitDir scan it has no stake in.
  if (manifest?.targets?.includes("linux-systemd")) {
    const systemdHost = resolveHost("linux-systemd", hostOverrides);
    const orphans = await findOrphanedSystemdUnits(db, systemdHost);
    checks.push({
      check: `No orphaned systemd units (${orphans.length} found)`,
      passed: orphans.length === 0,
      detail: orphans.length ? orphans.map((o) => o.unitPath).join(", ") : undefined,
    });
  }

  return {
    name,
    checks,
    allPassed: checks.every((c) => c.passed),
  };
}

/**
 * A rendered systemd unit file found in `host.paths.unitDir` that does not
 * correspond to any currently-active installed package's declared
 * `provides.systemdUnit`.
 */
export interface OrphanedUnit {
  unitPath: string;
  reason: string;
}

/**
 * Scan the linux-systemd host's `unitDir` for `*.service` files that no
 * ACTIVE installed package owns (arc#311). A unit left behind by an
 * interrupted `arc remove`, a manually-deleted DB row, or a package
 * disabled without its supervision side being torn down all show up here
 * — none of arc's other checks catch a leftover unit file, since `verify()`
 * otherwise only inspects the ONE named package's own expected drop.
 */
export async function findOrphanedSystemdUnits(
  db: Database,
  host: HostAdapter,
): Promise<OrphanedUnit[]> {
  const unitDir = (host.paths as Partial<LinuxSystemdHostPaths>).unitDir;
  if (!unitDir || !existsSync(unitDir)) return [];

  const owned = new Set<string>();
  for (const skill of listSkills(db)) {
    if (skill.status !== "active") continue;
    const skillManifest = await readManifest(skill.install_path);
    if (!skillManifest?.targets?.includes("linux-systemd")) continue;
    if (skillManifest.provides?.systemdUnit) {
      owned.add(basename(skillManifest.provides.systemdUnit));
    }
  }

  const orphans: OrphanedUnit[] = [];
  for (const entry of readdirSync(unitDir)) {
    if (!entry.endsWith(".service")) continue;
    if (owned.has(entry)) continue;
    orphans.push({
      unitPath: join(unitDir, entry),
      reason: "no active installed package declares this unit",
    });
  }
  return orphans;
}

/**
 * Suggest a fix when a missing hook target exists somewhere under the
 * package's repo dir. Common shape: caduceus declared
 *   command: ${PAI_DIR}/hooks/handlers/SkillNudge.ts
 * but the file actually lives at
 *   {repo}/hooks/handlers/SkillNudge.ts
 * and was never copied/symlinked into ${PAI_DIR}. Suggest adding a
 * provides.files entry so install lands the file at the expected target.
 */
function hintFromRepo(repoDir: string, missingPath: string): string {
  const basename = missingPath.split("/").pop();
  if (!basename) return "";
  const candidates = findFileInRepo(repoDir, basename, 4);
  if (candidates.length === 0) return "";
  const rel = relative(repoDir, candidates[0]);
  return `\n      hint: file exists at ${rel} in the package repo — add a provides.files entry to land it at the hook target`;
}

/**
 * Walk the package repo dir up to `maxDepth` levels deep looking for a file
 * matching `basename`. Returns absolute paths of matches. Skips node_modules
 * and dotdirs to keep the search bounded.
 */
function findFileInRepo(repoDir: string, basename: string, maxDepth: number): string[] {
  const matches: string[] = [];
  const skip = new Set(["node_modules", ".git"]);
  function walk(dir: string, depth: number): boolean {
    if (depth > maxDepth) return false;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || skip.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Short-circuit: once any subtree finds a match, stop walking siblings.
        if (walk(full, depth + 1)) return true;
      } else if (entry === basename) {
        matches.push(full);
        return true;
      }
    }
    return false;
  }
  walk(repoDir, 0);
  return matches;
}

/**
 * Format verify results for console display.
 */
export function formatVerify(result: VerifyResult): string {
  if (result.error) return `Error: ${result.error}`;

  const lines: string[] = [`Verify: ${result.name}`, ``];

  for (const check of result.checks) {
    const icon = check.passed ? "✅" : "❌";
    const detail = check.detail ? ` (${check.detail})` : "";
    lines.push(`  ${icon} ${check.check}${detail}`);
  }

  lines.push(``);
  lines.push(
    result.allPassed
      ? "All checks passed."
      : "Some checks failed — see above."
  );

  return lines.join("\n");
}
