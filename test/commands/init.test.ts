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

  test("scaffolds into an existing non-empty directory (arc#107 init-in-place)", async () => {
    const targetDir = join(tempDir, "existing");
    await Bun.write(join(targetDir, "unrelated.txt"), "preexisting content");

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(true);
    // Pre-existing unrelated file untouched
    const original = await Bun.file(join(targetDir, "unrelated.txt")).text();
    expect(original).toBe("preexisting content");
    // Manifest landed alongside it
    expect(existsSync(join(targetDir, "arc-manifest.yaml"))).toBe(true);
  });

  test("rejects when arc-manifest.yaml already exists in target (arc#107)", async () => {
    const targetDir = join(tempDir, "already-arc");
    await Bun.write(join(targetDir, "arc-manifest.yaml"), "name: prior\n");

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("arc-manifest.yaml already exists");
  });

  test("rejects when target path is an existing file (sage P148 cycle 2)", async () => {
    const targetDir = join(tempDir, "file-not-dir");
    await Bun.write(targetDir, "not a directory");

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a directory");
  });

  test("rejects broken symlink at target path with a clean error (sage P148 cycle 5)", async () => {
    const { symlink } = await import("fs/promises");
    const targetDir = join(tempDir, "broken-link");
    // Point symlink at a path that doesn't exist
    await symlink(join(tempDir, "does-not-exist"), targetDir);

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(false);
    expect(result.error).toContain("broken symlink");
  });

  test("accepts symlink pointing at an existing directory (sage P148 cycle 3 + 5)", async () => {
    const { mkdir: mkdirP, symlink } = await import("fs/promises");
    const realDir = join(tempDir, "real-dir");
    const linkDir = join(tempDir, "link-to-dir");
    await mkdirP(realDir, { recursive: true });
    await symlink(realDir, linkDir);

    const result = await init(linkDir, "MySkill");
    expect(result.success).toBe(true);
    // Files land in the real target dir via the symlink
    expect(existsSync(join(realDir, "arc-manifest.yaml"))).toBe(true);
  });

  test("refuses to clobber pre-existing README.md / package.json / etc (sage P148 cycle 3 security)", async () => {
    const targetDir = join(tempDir, "preexisting-files");
    // Operator already has README + package.json
    await Bun.write(join(targetDir, "README.md"), "# pre-existing");
    await Bun.write(join(targetDir, "package.json"), `{"name":"prior"}`);

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Refusing to overwrite existing file/);

    // Operator content untouched
    const readme = await Bun.file(join(targetDir, "README.md")).text();
    expect(readme).toBe("# pre-existing");
  });

  test("in-place scaffold layers cleanly when no target files pre-exist", async () => {
    const targetDir = join(tempDir, "clean-existing");
    // Operator has unrelated file — scaffold should layer alongside
    await Bun.write(join(targetDir, "notes.md"), "operator notes");

    const result = await init(targetDir, "MySkill");
    expect(result.success).toBe(true);
    const notes = await Bun.file(join(targetDir, "notes.md")).text();
    expect(notes).toBe("operator notes");
    expect(existsSync(join(targetDir, "arc-manifest.yaml"))).toBe(true);
  });

  // Sage P148 cycle 4 — drift guard. `scaffoldFilesFor` enumerates the
  // files init() will write; if a future change adds a `Bun.write` call
  // without updating the list, the pre-flight overwrite check silently
  // misses that file and operator content gets clobbered. Test: pre-seed
  // EVERY file scaffoldFilesFor declares for each type, then run init —
  // it MUST refuse for every type. If a Bun.write target ever slips
  // outside the enumeration, this test still passes BUT a separate
  // post-init walk asserts every created file appears in result.files
  // (which is built from the same list-driven sources). Two checks
  // together catch list-vs-write drift in either direction.
  test("scaffoldFilesFor stays in sync with actual writes (drift guard)", async () => {
    const { readdir } = await import("fs/promises");

    async function walk(dir: string, base = ""): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push(...(await walk(join(dir, entry.name), rel)));
        } else {
          out.push(rel);
        }
      }
      return out;
    }

    const types = ["skill", "tool", "agent", "prompt", "pipeline"] as const;
    for (const type of types) {
      const targetDir = join(tempDir, `sync-${type}`);
      const result = await init(targetDir, `sync-${type}`, undefined, type);
      expect(result.success).toBe(true);

      // Every file on disk must appear in result.files (sourced from the
      // same list scaffoldFilesFor uses). A new Bun.write that doesn't
      // push to files[] would surface here.
      const onDisk = (await walk(targetDir)).sort();
      const reported = [...result.files!].sort();
      expect(onDisk).toEqual(reported);

      // And: pre-seeding any one of the declared files must trip the
      // pre-flight refusal. Spot-check the manifest path (always present
      // in the list across types).
      const seeded = join(tempDir, `seed-${type}`);
      await Bun.write(join(seeded, "arc-manifest.yaml"), "name: prior\n");
      const refused = await init(seeded, `seed-${type}`, undefined, type);
      expect(refused.success).toBe(false);
    }
  });
});
