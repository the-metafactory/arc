import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, readlinkSync, mkdirSync, writeFileSync } from "fs";
import { mkdtemp, rm, symlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { openDatabase, recordInstall } from "../../src/lib/db.js";
import { createSymlink } from "../../src/lib/symlinks.js";
import {
  upgradeCore,
  type UpgradeConfig,
} from "../../src/commands/upgrade-core.js";
import type { ArcManifest } from "../../src/types.js";

interface MockPaiEnv {
  root: string;
  db: Database;
  config: UpgradeConfig;
  /** Path to "old" release .claude directory */
  oldRelease: string;
  /** Path to "new" release .claude directory */
  newRelease: string;
  /** Path to ~/.claude symlink */
  claudeSymlink: string;
  /** Path to config root (~/.config/arc/) */
  configRoot: string;
  /** Path to personal data repo */
  personalDataDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a mock PAI environment that simulates the real directory structure.
 *
 * Layout:
 *   root/
 *     .claude → old release (symlink)
 *     .config/arc/               (config root)
 *       .env
 *       MEMORY/
 *       secrets/
 *       CORE_USER/
 *       packages.db
 *     Developer/
 *       pai/versions/4.0-develop/Releases/
 *         v4.0.3/.claude/        (old release)
 *           hooks/
 *           skills/
 *           settings.json
 *           coupa/               (config dir with symlinks)
 *             patterns.json → personal-data
 *           jira/
 *             cache → config/skills/jira/cache
 *         v4.0.4/.claude/        (new release)
 *           hooks/
 *           skills/
 *           PAI/
 *           settings.json
 *       pai-personal-data/
 *         CLAUDE.md
 *         profiles/
 *           coupa/patterns.json
 *       pai-skill-alpha/         (mock installed skill)
 *         skill/SKILL.md
 *         arc-manifest.yaml
 */
async function createMockPaiEnv(): Promise<MockPaiEnv> {
  const root = await mkdtemp(join(tmpdir(), "pai-upgrade-test-"));

  // Config root
  const configRoot = join(root, ".config", "pai");
  await Bun.write(join(configRoot, ".env"), "OPENAI_API_KEY=test\n");
  await mkdir(join(configRoot, "MEMORY"), { recursive: true });
  await mkdir(join(configRoot, "secrets"), { recursive: true });
  await mkdir(join(configRoot, "CORE_USER"), { recursive: true });
  await mkdir(join(configRoot, "skills", "jira", "cache"), {
    recursive: true,
  });

  // Personal data
  const personalDataDir = join(root, "Developer", "pai-personal-data");
  await Bun.write(join(personalDataDir, "CLAUDE.md"), "# PAI\n");
  await mkdir(join(personalDataDir, "profiles", "coupa"), {
    recursive: true,
  });
  await Bun.write(
    join(personalDataDir, "profiles", "coupa", "patterns.json"),
    "{}"
  );

  // Versions directory
  const versionsDir = join(root, "Developer", "pai", "versions");
  const branch = "4.0-develop";

  // OLD release (v4.0.3)
  const oldRelease = join(
    versionsDir,
    branch,
    "Releases",
    "v4.0.3",
    ".claude"
  );
  await mkdir(join(oldRelease, "hooks"), { recursive: true });
  await mkdir(join(oldRelease, "skills"), { recursive: true });
  await mkdir(join(oldRelease, "PAI"), { recursive: true });
  await Bun.write(join(oldRelease, "settings.json"), "{}");
  await Bun.write(
    join(oldRelease, "hooks", "SecurityValidator.hook.ts"),
    "// hook"
  );

  // Old release persistent symlinks (simulating what exists today)
  await createSymlink(join(configRoot, ".env"), join(oldRelease, ".env"));
  await createSymlink(
    join(personalDataDir, "CLAUDE.md"),
    join(oldRelease, "CLAUDE.md")
  );
  await createSymlink(
    join(configRoot, "MEMORY"),
    join(oldRelease, "MEMORY")
  );
  await createSymlink(
    join(personalDataDir, "profiles"),
    join(oldRelease, "profiles")
  );
  await createSymlink(
    join(configRoot, "secrets"),
    join(oldRelease, "secrets")
  );
  await createSymlink(
    join(configRoot, "CORE_USER"),
    join(oldRelease, "PAI", "USER")
  );

  // Old release config directory symlinks (coupa/, jira/)
  await mkdir(join(oldRelease, "coupa"), { recursive: true });
  await createSymlink(
    join(personalDataDir, "profiles", "coupa", "patterns.json"),
    join(oldRelease, "coupa", "patterns.json")
  );
  await mkdir(join(oldRelease, "jira"), { recursive: true });
  await createSymlink(
    join(configRoot, "skills", "jira", "cache"),
    join(oldRelease, "jira", "cache")
  );

  // NEW release (v4.0.4) — minimal, as it would come from git checkout
  const newRelease = join(
    versionsDir,
    branch,
    "Releases",
    "v4.0.4",
    ".claude"
  );
  await mkdir(join(newRelease, "hooks"), { recursive: true });
  await mkdir(join(newRelease, "skills"), { recursive: true });
  await mkdir(join(newRelease, "PAI"), { recursive: true });
  await Bun.write(join(newRelease, "settings.json"), "{}");
  await Bun.write(
    join(newRelease, "hooks", "SecurityValidator.hook.ts"),
    "// hook v4.0.4"
  );

  // Create a mock installed skill repo
  const skillRepoDir = join(root, "Developer", "pai-skill-alpha");
  await Bun.write(
    join(skillRepoDir, "skill", "SKILL.md"),
    "---\nname: _ALPHA\n---\n# Alpha Skill\n"
  );
  await Bun.write(
    join(skillRepoDir, "arc-manifest.yaml"),
    "name: _ALPHA\nversion: 1.0.0\ntype: skill\nauthor:\n  name: test\n  github: test\ncapabilities:\n  filesystem:\n    read: []\n  network: []\n  bash:\n    allowed: false\n  secrets: []\n"
  );

  // Symlink old skill into old release
  await createSymlink(
    join(skillRepoDir, "skill"),
    join(oldRelease, "skills", "_ALPHA")
  );

  // Main ~/.claude symlink
  const claudeSymlink = join(root, ".claude");
  await symlink(oldRelease, claudeSymlink);

  // Database
  const dbPath = join(configRoot, "packages.db");
  const db = openDatabase(dbPath);

  // Record the mock skill in DB
  const manifest: ArcManifest = {
    name: "_ALPHA",
    version: "1.0.0",
    type: "skill",
    author: { name: "test", github: "test" },
    capabilities: {
      filesystem: { read: [] },
      network: [],
      bash: { allowed: false },
      secrets: [],
    },
  };

  recordInstall(
    db,
    {
      name: "_ALPHA",
      version: "1.0.0",
      repo_url: skillRepoDir,
      install_path: skillRepoDir,
      skill_dir: join(skillRepoDir, "skill"),
      status: "active",
      installed_at: "2026-03-18T00:00:00Z",
      updated_at: "2026-03-18T00:00:00Z",
    },
    manifest
  );

  const config: UpgradeConfig = {
    versionsDir,
    branch,
    personalDataDir,
    configRoot,
    homeDir: root,
    claudeSymlink,
  };

  return {
    root,
    db,
    config,
    oldRelease,
    newRelease,
    claudeSymlink,
    configRoot,
    personalDataDir,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

let env: MockPaiEnv;

beforeEach(async () => {
  env = await createMockPaiEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("upgrade-core command", () => {
  test("creates persistent symlinks in new release", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");

    expect(result.success).toBe(true);

    // Check each persistent symlink
    const newRelease = env.newRelease;

    const envLink = join(newRelease, ".env");
    expect(lstatSync(envLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(envLink)).toBe(join(env.configRoot, ".env"));

    const claudeMdLink = join(newRelease, "CLAUDE.md");
    expect(lstatSync(claudeMdLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeMdLink)).toBe(
      join(env.personalDataDir, "CLAUDE.md")
    );

    const memoryLink = join(newRelease, "MEMORY");
    expect(lstatSync(memoryLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(memoryLink)).toBe(
      join(env.configRoot, "MEMORY")
    );

    const profilesLink = join(newRelease, "profiles");
    expect(lstatSync(profilesLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(profilesLink)).toBe(
      join(env.personalDataDir, "profiles")
    );

    const secretsLink = join(newRelease, "secrets");
    expect(lstatSync(secretsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(secretsLink)).toBe(
      join(env.configRoot, "secrets")
    );

    const userLink = join(newRelease, "PAI", "USER");
    expect(lstatSync(userLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(userLink)).toBe(
      join(env.configRoot, "CORE_USER")
    );
  });

  test("re-symlinks installed skills from packages.db", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");
    expect(result.success).toBe(true);

    const skillLink = join(env.newRelease, "skills", "_ALPHA");
    expect(existsSync(skillLink)).toBe(true);
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);

    // Points to the skill repo's skill/ dir
    const target = readlinkSync(skillLink);
    expect(target).toContain("pai-skill-alpha/skill");
  });

  test("re-symlinks bin tools from packages.db", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");
    expect(result.success).toBe(true);

    const binLink = join(env.newRelease, "bin", "alpha");
    expect(existsSync(binLink)).toBe(true);
    expect(lstatSync(binLink).isSymbolicLink()).toBe(true);
  });

  test("carries forward config directory symlinks from old release", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");
    expect(result.success).toBe(true);

    // coupa/patterns.json should be carried forward
    const coupaLink = join(env.newRelease, "coupa", "patterns.json");
    expect(existsSync(coupaLink)).toBe(true);
    expect(lstatSync(coupaLink).isSymbolicLink()).toBe(true);

    // jira/cache should be carried forward
    const jiraLink = join(env.newRelease, "jira", "cache");
    expect(existsSync(jiraLink)).toBe(true);
    expect(lstatSync(jiraLink).isSymbolicLink()).toBe(true);
  });

  test("swaps main ~/.claude symlink to new release", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");
    expect(result.success).toBe(true);

    const newTarget = readlinkSync(env.claudeSymlink);
    expect(newTarget).toContain("v4.0.4");
    expect(newTarget).not.toContain("v4.0.3");
  });

  test("detects previous version from current symlink", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");
    expect(result.previousVersion).toBe("v4.0.3");
  });

  test("validates after upgrade", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");
    expect(result.success).toBe(true);

    const validateSteps = result.steps.filter(
      (s) => s.action === "validate"
    );
    expect(validateSteps.length).toBe(1);
    expect(validateSteps[0].status).toBe("ok");
  });

  test("fails if release directory not found", async () => {
    const result = await upgradeCore(env.db, env.config, "v9.9.9");
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Release directory not found");
  });

  test("accepts version without v prefix", async () => {
    const result = await upgradeCore(env.db, env.config, "4.0.4");
    expect(result.success).toBe(true);
    expect(result.targetVersion).toBe("v4.0.4");
  });

  test("reports all steps taken", async () => {
    const result = await upgradeCore(env.db, env.config, "v4.0.4");

    const actionTypes = [
      ...new Set(result.steps.map((s) => s.action)),
    ];
    expect(actionTypes).toContain("locate");
    expect(actionTypes).toContain("persistent-symlink");
    expect(actionTypes).toContain("skill-symlink");
    expect(actionTypes).toContain("bin-symlink");
    expect(actionTypes).toContain("config-symlink");
    expect(actionTypes).toContain("main-symlink");
    expect(actionTypes).toContain("validate");
  });
});
