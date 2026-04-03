import { join, dirname, basename } from "path";
import { existsSync, readdirSync, lstatSync, readlinkSync } from "fs";
import { mkdir, readdir } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { PaiPaths } from "../types.js";
import { listSkills } from "../lib/db.js";
import { createSymlink, isValidSymlink, getSymlinkTarget } from "../lib/symlinks.js";

/**
 * Configuration for upgrade-core.
 * Describes where PAI lives and where persistent data is stored.
 */
export interface UpgradeConfig {
  /** PAI versions directory (e.g. ~/Developer/pai/versions/) */
  versionsDir: string;
  /** Branch directory name (e.g. "4.0-develop") */
  branch: string;
  /** Personal data repo (e.g. ~/Developer/pai-personal-data/) */
  personalDataDir: string;
  /** Config root (e.g. ~/.config/metafactory/) */
  configRoot: string;
  /** Home directory */
  homeDir: string;
  /** Path to main ~/.claude symlink */
  claudeSymlink: string;
}

export interface UpgradeStep {
  action: string;
  target: string;
  status: "ok" | "created" | "failed" | "skipped";
  detail?: string;
}

export interface UpgradeResult {
  success: boolean;
  targetVersion: string;
  previousVersion?: string;
  newReleaseDir: string;
  steps: UpgradeStep[];
  errors: string[];
}

/**
 * Upgrade PAI core to a new version.
 *
 * Based on the v3→v4 migration plan, this automates:
 * 1. Locate new release directory
 * 2. Create persistent symlinks (.env, CLAUDE.md, MEMORY, profiles, secrets, PAI/USER)
 * 3. Re-symlink all installed skills from packages.db
 * 4. Re-symlink all bin tools from packages.db
 * 5. Carry forward config directory symlinks from old release
 * 6. Swap main ~/.claude symlink
 * 7. Validate
 */
export async function upgradeCore(
  db: Database,
  config: UpgradeConfig,
  targetVersion: string
): Promise<UpgradeResult> {
  const steps: UpgradeStep[] = [];
  const errors: string[] = [];

  // Normalize version (accept "4.0.4" or "v4.0.4")
  const version = targetVersion.startsWith("v")
    ? targetVersion
    : `v${targetVersion}`;

  // 1. Locate new release directory
  const newReleaseDir = join(
    config.versionsDir,
    config.branch,
    "Releases",
    version,
    ".claude"
  );

  if (!existsSync(newReleaseDir)) {
    return {
      success: false,
      targetVersion: version,
      newReleaseDir,
      steps,
      errors: [
        `Release directory not found: ${newReleaseDir}. Run: git checkout ${version} -- Releases/${version}/`,
      ],
    };
  }

  steps.push({
    action: "locate",
    target: newReleaseDir,
    status: "ok",
    detail: "New release directory found",
  });

  // Detect previous version from current symlink
  let previousVersion: string | undefined;
  const currentTarget = await getSymlinkTarget(config.claudeSymlink);
  if (currentTarget) {
    const match = currentTarget.match(/Releases\/(v[\d.]+)\//);
    if (match) previousVersion = match[1];
  }

  // 2. Create persistent symlinks
  const persistentLinks: Array<{
    name: string;
    linkPath: string;
    target: string;
  }> = [
    {
      name: ".env",
      linkPath: join(newReleaseDir, ".env"),
      target: join(config.configRoot, ".env"),
    },
    {
      name: "CLAUDE.md",
      linkPath: join(newReleaseDir, "CLAUDE.md"),
      target: join(config.personalDataDir, "CLAUDE.md"),
    },
    {
      name: "MEMORY",
      linkPath: join(newReleaseDir, "MEMORY"),
      target: join(config.configRoot, "MEMORY"),
    },
    {
      name: "profiles",
      linkPath: join(newReleaseDir, "profiles"),
      target: join(config.personalDataDir, "profiles"),
    },
    {
      name: "secrets",
      linkPath: join(newReleaseDir, "secrets"),
      target: join(config.configRoot, "secrets"),
    },
    {
      name: "PAI/USER",
      linkPath: join(newReleaseDir, "PAI", "USER"),
      target: join(config.configRoot, "CORE_USER"),
    },
  ];

  for (const link of persistentLinks) {
    try {
      // Only create if the target exists
      if (existsSync(link.target)) {
        await createSymlink(link.target, link.linkPath);
        steps.push({
          action: "persistent-symlink",
          target: link.name,
          status: "created",
          detail: `${link.linkPath} → ${link.target}`,
        });
      } else {
        steps.push({
          action: "persistent-symlink",
          target: link.name,
          status: "skipped",
          detail: `Target not found: ${link.target}`,
        });
      }
    } catch (err: any) {
      steps.push({
        action: "persistent-symlink",
        target: link.name,
        status: "failed",
        detail: err.message,
      });
      errors.push(`Failed to create ${link.name} symlink: ${err.message}`);
    }
  }

  // 2b. Detect skill customizations that may be affected by upgrade
  const customizationsDir = join(newReleaseDir, "PAI", "USER", "SKILLCUSTOMIZATIONS");
  if (existsSync(customizationsDir)) {
    try {
      const customDirs = readdirSync(customizationsDir).filter(
        (d) => !d.startsWith(".") && d !== "README.md"
      );
      if (customDirs.length > 0) {
        steps.push({
          action: "customization-warning",
          target: "SKILLCUSTOMIZATIONS",
          status: "ok",
          detail: `${customDirs.length} customized skill(s): ${customDirs.join(", ")}. Verify compatibility after upgrade.`,
        });
      }
    } catch {
      // Can't read — not critical
    }
  }

  // 3. Re-symlink all installed skills from packages.db
  const skills = listSkills(db);
  const activeSkills = skills.filter((s) => s.status === "active");
  const skillsDir = join(newReleaseDir, "skills");
  await mkdir(skillsDir, { recursive: true });

  for (const skill of activeSkills) {
    try {
      const skillSource = skill.skill_dir;
      // Fall back to install_path/skill if skill_dir doesn't exist
      const effectiveSource = existsSync(skillSource)
        ? skillSource
        : join(skill.install_path, "skill");

      if (existsSync(effectiveSource)) {
        const skillLink = join(skillsDir, skill.name);
        await createSymlink(effectiveSource, skillLink);
        steps.push({
          action: "skill-symlink",
          target: skill.name,
          status: "created",
          detail: `${skillLink} → ${effectiveSource}`,
        });
      } else {
        steps.push({
          action: "skill-symlink",
          target: skill.name,
          status: "skipped",
          detail: `Source not found: ${effectiveSource}`,
        });
      }
    } catch (err: any) {
      steps.push({
        action: "skill-symlink",
        target: skill.name,
        status: "failed",
        detail: err.message,
      });
      errors.push(
        `Failed to symlink skill ${skill.name}: ${err.message}`
      );
    }
  }

  // 4. Re-symlink bin tools from packages.db
  const binDir = join(newReleaseDir, "bin");
  await mkdir(binDir, { recursive: true });

  for (const skill of activeSkills) {
    try {
      if (existsSync(skill.install_path)) {
        const binName = skill.name.replace(/^_/, "").toLowerCase();
        const binLink = join(binDir, binName);
        await createSymlink(skill.install_path, binLink);
        steps.push({
          action: "bin-symlink",
          target: binName,
          status: "created",
          detail: `${binLink} → ${skill.install_path}`,
        });
      }
    } catch (err: any) {
      steps.push({
        action: "bin-symlink",
        target: skill.name,
        status: "failed",
        detail: err.message,
      });
    }
  }

  // 5. Carry forward config directory symlinks from old release
  if (currentTarget) {
    const oldReleaseDir = currentTarget;
    await carryForwardConfigSymlinks(
      oldReleaseDir,
      newReleaseDir,
      steps,
      errors
    );
  }

  // 6. Swap main ~/.claude symlink
  try {
    await createSymlink(newReleaseDir, config.claudeSymlink);
    steps.push({
      action: "main-symlink",
      target: config.claudeSymlink,
      status: "created",
      detail: `${config.claudeSymlink} → ${newReleaseDir}`,
    });
  } catch (err: any) {
    steps.push({
      action: "main-symlink",
      target: config.claudeSymlink,
      status: "failed",
      detail: err.message,
    });
    errors.push(`Failed to swap main symlink: ${err.message}`);
  }

  // 7. Validate
  const validationErrors = await validate(newReleaseDir, config);
  for (const ve of validationErrors) {
    steps.push({
      action: "validate",
      target: ve.check,
      status: "failed",
      detail: ve.detail,
    });
    errors.push(`Validation: ${ve.detail}`);
  }

  if (validationErrors.length === 0) {
    steps.push({
      action: "validate",
      target: "all",
      status: "ok",
      detail: "All validation checks passed",
    });
  }

  return {
    success: errors.length === 0,
    targetVersion: version,
    previousVersion,
    newReleaseDir,
    steps,
    errors,
  };
}

/**
 * Scan the old release directory for config symlinks (jira/, coupa/, oncharge/, etc.)
 * and recreate them in the new release directory.
 *
 * This handles skill-specific config directories that bridge to persistent locations.
 * E.g., ~/.claude/coupa/patterns.json → pai-personal-data/profiles/coupa/patterns.json
 */
async function carryForwardConfigSymlinks(
  oldReleaseDir: string,
  newReleaseDir: string,
  steps: UpgradeStep[],
  errors: string[]
): Promise<void> {
  // Directories to skip — these are managed explicitly above
  const skipDirs = new Set([
    "skills",
    "bin",
    "hooks",
    "PAI",
    "PAI-Install",
    "VoiceServer",
    "context",
    "node_modules",
    ".git",
  ]);

  // Files to skip — managed by persistent symlinks
  const skipFiles = new Set([
    ".env",
    "CLAUDE.md",
    "MEMORY",
    "profiles",
    "secrets",
    "settings.json",
    "settings.local.json",
  ]);

  let entries: string[];
  try {
    entries = readdirSync(oldReleaseDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (skipDirs.has(entry) || skipFiles.has(entry) || entry.startsWith(".")) {
      continue;
    }

    const oldPath = join(oldReleaseDir, entry);
    let stat;
    try {
      stat = lstatSync(oldPath);
    } catch {
      continue;
    }

    // If it's a directory, scan for symlinks inside it
    if (stat.isDirectory()) {
      const newDir = join(newReleaseDir, entry);
      await mkdir(newDir, { recursive: true });

      let subEntries: string[];
      try {
        subEntries = readdirSync(oldPath);
      } catch {
        continue;
      }

      for (const subEntry of subEntries) {
        const subPath = join(oldPath, subEntry);
        try {
          const subStat = lstatSync(subPath);
          if (subStat.isSymbolicLink()) {
            const target = readlinkSync(subPath);
            const newLink = join(newDir, subEntry);
            await createSymlink(target, newLink);
            steps.push({
              action: "config-symlink",
              target: `${entry}/${subEntry}`,
              status: "created",
              detail: `${newLink} → ${target}`,
            });
          }
        } catch (err: any) {
          errors.push(
            `Failed to carry forward ${entry}/${subEntry}: ${err.message}`
          );
        }
      }
    }
  }
}

/**
 * Validate the new release directory after upgrade.
 */
async function validate(
  releaseDir: string,
  config: UpgradeConfig
): Promise<Array<{ check: string; detail: string }>> {
  const failures: Array<{ check: string; detail: string }> = [];

  // Check core persistent symlinks
  const checks = [
    { name: ".env", path: join(releaseDir, ".env") },
    { name: "CLAUDE.md", path: join(releaseDir, "CLAUDE.md") },
    { name: "MEMORY", path: join(releaseDir, "MEMORY") },
    { name: "profiles", path: join(releaseDir, "profiles") },
    { name: "PAI/USER", path: join(releaseDir, "PAI", "USER") },
  ];

  for (const check of checks) {
    if (!(await isValidSymlink(check.path))) {
      failures.push({
        check: check.name,
        detail: `Persistent symlink invalid: ${check.path}`,
      });
    }
  }

  // Check hooks directory exists
  const hooksDir = join(releaseDir, "hooks");
  if (!existsSync(hooksDir)) {
    failures.push({
      check: "hooks",
      detail: "Hooks directory not found in new release",
    });
  }

  // Check skills directory exists
  const skillsDir = join(releaseDir, "skills");
  if (!existsSync(skillsDir)) {
    failures.push({
      check: "skills",
      detail: "Skills directory not found in new release",
    });
  }

  return failures;
}

/**
 * Format upgrade results for console display.
 */
export function formatUpgrade(result: UpgradeResult): string {
  const lines: string[] = [];

  if (result.previousVersion) {
    lines.push(
      `Upgrade: ${result.previousVersion} → ${result.targetVersion}`
    );
  } else {
    lines.push(`Upgrade to ${result.targetVersion}`);
  }
  lines.push(``);

  // Group steps by action
  const groups = new Map<string, UpgradeStep[]>();
  for (const step of result.steps) {
    const existing = groups.get(step.action) ?? [];
    existing.push(step);
    groups.set(step.action, existing);
  }

  for (const [action, steps] of groups) {
    const label = formatActionLabel(action);
    const okCount = steps.filter(
      (s) => s.status === "ok" || s.status === "created"
    ).length;
    const failCount = steps.filter((s) => s.status === "failed").length;
    const skipCount = steps.filter((s) => s.status === "skipped").length;

    lines.push(`${label}: ${okCount} ok, ${failCount} failed, ${skipCount} skipped`);

    // Show failures and skips in detail
    for (const step of steps) {
      if (step.status === "failed") {
        lines.push(`  ❌ ${step.target}: ${step.detail}`);
      } else if (step.status === "skipped") {
        lines.push(`  ⏭️  ${step.target}: ${step.detail}`);
      }
    }
  }

  lines.push(``);
  if (result.success) {
    lines.push(`✅ Upgrade complete. Restart Claude Code to use ${result.targetVersion}.`);
  } else {
    lines.push(`❌ Upgrade completed with errors:`);
    for (const err of result.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join("\n");
}

function formatActionLabel(action: string): string {
  switch (action) {
    case "locate":
      return "📍 Release";
    case "persistent-symlink":
      return "🔗 Persistent symlinks";
    case "skill-symlink":
      return "🧩 Skill symlinks";
    case "bin-symlink":
      return "⚙️  Bin symlinks";
    case "config-symlink":
      return "📁 Config symlinks";
    case "main-symlink":
      return "🔄 Main symlink swap";
    case "customization-warning":
      return "⚠️  Customizations";
    case "validate":
      return "✅ Validation";
    default:
      return action;
  }
}
