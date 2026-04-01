import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import {
  listSkills,
  getSkill,
  recordInstall,
  updateSkillStatus,
  removeSkill,
  getCapabilities,
  getAllActiveCapabilities,
} from "../../src/lib/db.js";
import type { ArcManifest } from "../../src/types.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

const mockManifest: ArcManifest = {
  name: "TestSkill",
  version: "1.0.0",
  type: "skill",
  author: { name: "test", github: "test" },
  capabilities: {
    filesystem: {
      read: ["~/.claude/MEMORY/"],
      write: ["~/.claude/MEMORY/WORK/"],
    },
    network: [{ domain: "api.example.com", reason: "API calls" }],
    bash: { allowed: true, restricted_to: ["bun src/tool.ts"] },
    secrets: ["API_KEY"],
  },
};

describe("Database", () => {
  test("creates tables on open", () => {
    const tables = env.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name);
    expect(names).toContain("skills");
    expect(names).toContain("capabilities");
  });

  test("records an installed skill", () => {
    recordInstall(
      env.db,
      {
        name: "TestSkill",
        version: "1.0.0",
        repo_url: "/path/to/repo",
        install_path: "/path/to/install",
        skill_dir: "/path/to/install/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      mockManifest
    );

    const skill = getSkill(env.db, "TestSkill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("TestSkill");
    expect(skill!.version).toBe("1.0.0");
    expect(skill!.status).toBe("active");
  });

  test("records capabilities alongside skill", () => {
    recordInstall(
      env.db,
      {
        name: "TestSkill",
        version: "1.0.0",
        repo_url: "/path/to/repo",
        install_path: "/path/to/install",
        skill_dir: "/path/to/install/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      mockManifest
    );

    const caps = getCapabilities(env.db, "TestSkill");
    expect(caps.length).toBe(5); // 1 read + 1 write + 1 network + 1 bash + 1 secret

    const types = caps.map((c) => c.type);
    expect(types).toContain("fs_read");
    expect(types).toContain("fs_write");
    expect(types).toContain("network");
    expect(types).toContain("bash");
    expect(types).toContain("secret");
  });

  test("lists installed skills", () => {
    recordInstall(
      env.db,
      {
        name: "SkillA",
        version: "1.0.0",
        repo_url: "/a",
        install_path: "/a",
        skill_dir: "/a/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      { ...mockManifest, name: "SkillA" }
    );

    recordInstall(
      env.db,
      {
        name: "SkillB",
        version: "2.0.0",
        repo_url: "/b",
        install_path: "/b",
        skill_dir: "/b/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      { ...mockManifest, name: "SkillB" }
    );

    const skills = listSkills(env.db);
    expect(skills.length).toBe(2);
    expect(skills[0].name).toBe("SkillA");
    expect(skills[1].name).toBe("SkillB");
  });

  test("updates skill status", () => {
    recordInstall(
      env.db,
      {
        name: "TestSkill",
        version: "1.0.0",
        repo_url: "/path",
        install_path: "/path",
        skill_dir: "/path/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      mockManifest
    );

    updateSkillStatus(env.db, "TestSkill", "disabled");
    const skill = getSkill(env.db, "TestSkill");
    expect(skill!.status).toBe("disabled");
  });

  test("removes skill and cascades capabilities", () => {
    recordInstall(
      env.db,
      {
        name: "TestSkill",
        version: "1.0.0",
        repo_url: "/path",
        install_path: "/path",
        skill_dir: "/path/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      mockManifest
    );

    removeSkill(env.db, "TestSkill");
    expect(getSkill(env.db, "TestSkill")).toBeNull();
    expect(getCapabilities(env.db, "TestSkill").length).toBe(0);
  });

  test("getAllActiveCapabilities filters by active status", () => {
    recordInstall(
      env.db,
      {
        name: "Active",
        version: "1.0.0",
        repo_url: "/a",
        install_path: "/a",
        skill_dir: "/a/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      { ...mockManifest, name: "Active" }
    );

    recordInstall(
      env.db,
      {
        name: "Disabled",
        version: "1.0.0",
        repo_url: "/d",
        install_path: "/d",
        skill_dir: "/d/skill",
        status: "active",
        installed_at: "2026-03-18T00:00:00Z",
        updated_at: "2026-03-18T00:00:00Z",
      },
      { ...mockManifest, name: "Disabled" }
    );

    updateSkillStatus(env.db, "Disabled", "disabled");

    const activeCaps = getAllActiveCapabilities(env.db);
    const skillNames = [...new Set(activeCaps.map((c) => c.skill_name))];
    expect(skillNames).toContain("Active");
    expect(skillNames).not.toContain("Disabled");
  });
});
