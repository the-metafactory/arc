import { join } from "path";
import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { getSkill } from "../lib/db.js";
import { isValidSymlink } from "../lib/symlinks.js";
import { readManifest } from "../lib/manifest.js";

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
export async function verify(
  db: Database,
  paths: PaiPaths,
  name: string
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

  // Check 2: pai-manifest.yaml exists
  const manifest = await readManifest(skill.install_path);
  checks.push({
    check: "pai-manifest.yaml valid",
    passed: manifest !== null,
  });

  // Check 3: Skill symlink valid (only for active skills)
  if (skill.status === "active") {
    const skillLink = join(paths.skillsDir, name);
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
    const isClean = result.stdout.toString().trim() === "";
    checks.push({
      check: "Git repo clean",
      passed: isClean,
      detail: isClean ? undefined : "Uncommitted changes detected",
    });
  }

  return {
    name,
    checks,
    allPassed: checks.every((c) => c.passed),
  };
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
