import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { audit } from "../../src/commands/audit.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("audit command", () => {
  test("reports total capability surface counts", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      capabilities: {
        filesystem: {
          read: ["~/.claude/MEMORY/"],
          write: ["~/.claude/MEMORY/WORK/"],
        },
        network: [{ domain: "api.example.com", reason: "API" }],
        bash: { allowed: true, restricted_to: ["bun src/tool.ts"] },
        secrets: ["API_KEY"],
      },
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = audit(env.db);
    expect(result.totalSkills).toBe(1);
    expect(result.activeSkills).toBe(1);
    expect(result.surface.fs_read).toBe(1);
    expect(result.surface.fs_write).toBe(1);
    expect(result.surface.network).toBe(1);
    expect(result.surface.bash).toBe(1);
    expect(result.surface.secret).toBe(1);
  });

  test("detects network + file-write combination warning", async () => {
    // Skill A has network access
    const repoA = await createMockSkillRepo(env.root, {
      name: "SkillA",
      capabilities: {
        network: [{ domain: "api.example.com", reason: "API" }],
      },
    });

    // Skill B has file write access
    const repoB = await createMockSkillRepo(env.root, {
      name: "SkillB",
      capabilities: {
        filesystem: { write: ["~/.claude/MEMORY/WORK/"] },
      },
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repoA.url,
      yes: true,
    });
    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repoB.url,
      yes: true,
    });

    const result = audit(env.db);
    expect(result.warnings.length).toBeGreaterThan(0);

    const downloadWrite = result.warnings.find((w) =>
      w.description.includes("download-and-write")
    );
    expect(downloadWrite).toBeDefined();
    expect(downloadWrite!.risk).toBe("high");
  });

  test("no warnings for single skill", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "SafeSkill",
      capabilities: {
        filesystem: { read: ["/safe/path"] },
      },
    });

    await install({
      paths: env.paths,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const result = audit(env.db);
    expect(result.warnings.length).toBe(0);
  });
});
