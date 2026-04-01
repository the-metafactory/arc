import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { init } from "../../src/commands/init.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pai-init-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("init command", () => {
  test("scaffolds skill directory structure", async () => {
    const targetDir = join(tempDir, "my-skill");
    const result = await init(targetDir, "MySkill", "testauthor");

    expect(result.success).toBe(true);
    expect(existsSync(join(targetDir, "skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(targetDir, "skill", "workflows", "Main.md"))).toBe(true);
    expect(existsSync(join(targetDir, "arc-manifest.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(join(targetDir, "README.md"))).toBe(true);
    expect(existsSync(join(targetDir, ".gitignore"))).toBe(true);
  });

  test("generates manifest with correct author", async () => {
    const targetDir = join(tempDir, "my-skill");
    await init(targetDir, "MySkill", "myuser");

    const content = await Bun.file(
      join(targetDir, "arc-manifest.yaml")
    ).text();
    expect(content).toContain("name: MySkill");
    expect(content).toContain("myuser");
  });

  test("generates SKILL.md with proper frontmatter", async () => {
    const targetDir = join(tempDir, "my-skill");
    await init(targetDir, "MySkill");

    const content = await Bun.file(
      join(targetDir, "skill", "SKILL.md")
    ).text();
    expect(content).toContain("name: MySkill");
    expect(content).toContain("---");
  });

  test("scaffolds pipeline directory structure", async () => {
    const targetDir = join(tempDir, "my-pipeline");
    const result = await init(targetDir, "P_RSS_DIGEST", "testauthor", "pipeline");

    expect(result.success).toBe(true);
    expect(existsSync(join(targetDir, "arc-manifest.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "pipeline.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "A_EXAMPLE", "action.json"))).toBe(true);
    expect(existsSync(join(targetDir, "A_EXAMPLE", "action.ts"))).toBe(true);

    const manifest = await Bun.file(join(targetDir, "arc-manifest.yaml")).text();
    expect(manifest).toContain("type: pipeline");
    expect(manifest).toContain("name: P_RSS_DIGEST");
  });

  test("rejects existing directory", async () => {
    const targetDir = join(tempDir, "existing");
    await Bun.write(join(targetDir, "file.txt"), "exists");

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });
});
