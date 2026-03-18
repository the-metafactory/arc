import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { list } from "../../src/commands/list.js";
import { info } from "../../src/commands/info.js";
import { audit } from "../../src/commands/audit.js";
import { disable } from "../../src/commands/disable.js";
import { enable } from "../../src/commands/enable.js";
import { remove } from "../../src/commands/remove.js";
import { verify } from "../../src/commands/verify.js";
import { getSkill, getCapabilities } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("Full lifecycle: install → list → info → audit → disable → enable → remove", () => {
  test("complete lifecycle for a skill with CLI", async () => {
    // --- SOURCE: Create a mock skill repo simulating pai-skill-jira ---
    const repo = await createMockSkillRepo(env.root, {
      name: "_JIRA",
      version: "1.1.0",
      author: "mellanon",
      withCli: true,
      capabilities: {
        filesystem: {
          read: ["skill/projects.json", "~/.claude/MEMORY/"],
          write: ["~/.claude/MEMORY/", "skill/cache/"],
        },
        network: [
          { domain: "*.atlassian.net", reason: "Jira REST API" },
        ],
        bash: {
          allowed: true,
          restricted_to: ["bun src/jira.ts *"],
        },
        secrets: ["JIRA_URL", "JIRA_API_TOKEN"],
      },
    });

    // --- INSTALL ---
    const installResult = await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(installResult.success).toBe(true);
    expect(installResult.name).toBe("_JIRA");
    expect(installResult.version).toBe("1.1.0");

    // Verify filesystem state
    const skillLink = join(env.paths.skillsDir, "_JIRA");
    expect(existsSync(skillLink)).toBe(true);
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);

    const binLink = join(env.paths.binDir, "jira");
    expect(existsSync(binLink)).toBe(true);

    // Verify database state
    const dbSkill = getSkill(env.db, "_JIRA");
    expect(dbSkill).not.toBeNull();
    expect(dbSkill!.status).toBe("active");
    expect(dbSkill!.version).toBe("1.1.0");

    const caps = getCapabilities(env.db, "_JIRA");
    // 2 fs_read + 2 fs_write + 1 network + 1 bash + 2 secret = 8
    expect(caps.length).toBe(8);

    // --- LIST ---
    const listResult = list(env.db);
    expect(listResult.skills.length).toBe(1);
    expect(listResult.skills[0].name).toBe("_JIRA");
    expect(listResult.skills[0].status).toBe("active");

    // --- INFO ---
    const infoResult = await info(env.db, "_JIRA");
    expect(infoResult.skill).not.toBeNull();
    expect(infoResult.manifest).not.toBeNull();
    expect(infoResult.manifest!.author.name).toBe("mellanon");

    // --- VERIFY ---
    const verifyResult = await verify(env.db, env.paths, "_JIRA");
    expect(verifyResult.allPassed).toBe(true);

    // --- AUDIT ---
    const auditResult = audit(env.db);
    expect(auditResult.totalSkills).toBe(1);
    expect(auditResult.surface.network).toBe(1);
    expect(auditResult.surface.secret).toBe(2);

    // --- DISABLE ---
    const disableResult = await disable(env.db, env.paths, "_JIRA");
    expect(disableResult.success).toBe(true);

    // Symlink removed
    expect(existsSync(skillLink)).toBe(false);

    // DB updated
    const disabledSkill = getSkill(env.db, "_JIRA");
    expect(disabledSkill!.status).toBe("disabled");

    // Repo preserved
    const repoDir = join(env.paths.reposDir, "mock-_JIRA");
    expect(existsSync(repoDir)).toBe(true);

    // List shows disabled
    const listAfterDisable = list(env.db);
    expect(listAfterDisable.skills[0].status).toBe("disabled");

    // --- ENABLE ---
    const enableResult = await enable(env.db, env.paths, "_JIRA");
    expect(enableResult.success).toBe(true);

    // Symlink re-created
    expect(existsSync(skillLink)).toBe(true);

    // DB updated
    const enabledSkill = getSkill(env.db, "_JIRA");
    expect(enabledSkill!.status).toBe("active");

    // --- REMOVE ---
    const removeResult = await remove(env.db, env.paths, "_JIRA");
    expect(removeResult.success).toBe(true);

    // Everything gone
    expect(existsSync(skillLink)).toBe(false);
    expect(existsSync(repoDir)).toBe(false);
    expect(getSkill(env.db, "_JIRA")).toBeNull();
    expect(getCapabilities(env.db, "_JIRA").length).toBe(0);

    // List empty
    const listAfterRemove = list(env.db);
    expect(listAfterRemove.skills.length).toBe(0);
  });

  test("multi-skill audit detects dangerous combinations", async () => {
    // Skill with network access
    const networkRepo = await createMockSkillRepo(env.root, {
      name: "NetworkSkill",
      capabilities: {
        network: [{ domain: "api.evil.com", reason: "External API" }],
        secrets: ["API_KEY"],
      },
    });

    // Skill with file access
    const fileRepo = await createMockSkillRepo(env.root, {
      name: "FileSkill",
      capabilities: {
        filesystem: {
          read: ["~/.claude/MEMORY/"],
          write: ["~/.claude/MEMORY/WORK/"],
        },
      },
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: networkRepo.url,
      yes: true,
    });
    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: fileRepo.url,
      yes: true,
    });

    const auditResult = audit(env.db);
    expect(auditResult.totalSkills).toBe(2);
    expect(auditResult.activeSkills).toBe(2);

    // Should detect network + file write combination
    const downloadWrite = auditResult.warnings.find((w) =>
      w.description.includes("download-and-write")
    );
    expect(downloadWrite).toBeDefined();

    // Should detect potential exfiltration (network + secret + file read)
    const exfil = auditResult.warnings.find((w) =>
      w.description.includes("exfiltration")
    );
    expect(exfil).toBeDefined();
  });

  test("tests never touch real ~/.claude or ~/.config", () => {
    // Verify test paths don't point to real directories
    expect(env.paths.claudeRoot).not.toContain(Bun.env.HOME + "/.claude");
    expect(env.paths.configRoot).not.toContain(
      Bun.env.HOME + "/.config/pai"
    );
    expect(env.paths.claudeRoot).toContain("pai-pkg-test-");
  });
});
