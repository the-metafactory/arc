/**
 * Tests for the two provides.files install-time guards:
 *
 *   - arc#419: a target whose RESOLVED path still contains an unexpanded
 *     `$VAR`/`${VAR}`/`%VAR%` is refused at plan time, before any filesystem
 *     write — never silently creates a literal `$FOO` directory.
 *   - arc#420: a target that already exists as content this package does not
 *     own (not a symlink pointing at this package's own source) is refused,
 *     naming the path, unless `--replace` is passed. An owned symlink from a
 *     prior install of the SAME package is always updated silently.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { createArtifactSymlinks } from "../../src/lib/artifact-installer.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("provides.files — arc#419 unexpanded variable refusal", () => {
  test("refuses at plan time; nothing is created", async () => {
    // A relative target containing a literal, un-substituted $VAR — the
    // arc#419 repro (mellanon's fault-injection: target `$FOO/skills/x`).
    const target = "$FOO/skills/website-oracle";
    const repo = await createMockSkillRepo(env.root, {
      name: "BadVarPkg",
      files: [{ source: "files/x.md", target, content: "hi\n" }],
    });

    const cwdBefore = process.cwd();
    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("$FOO");
    expect(result.error).toContain("unexpanded variable");

    // Nothing landed anywhere — neither the primary skill symlink…
    expect(existsSync(join(env.host.paths.skillsDir, "BadVarPkg"))).toBe(false);
    // …nor a stray literal "$FOO" directory relative to cwd (the arc#419 bug).
    expect(existsSync(join(cwdBefore, "$FOO"))).toBe(false);
  });

  test("a %VAR% (Windows-style) placeholder is refused the same way", async () => {
    const target = "%APPDATA%/arc-pkg/x";
    const repo = await createMockSkillRepo(env.root, {
      name: "BadPercentPkg",
      files: [{ source: "files/x.md", target, content: "hi\n" }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("%APPDATA%");
  });

  test("a clean, fully-resolved target installs normally (no false positive)", async () => {
    const target = join(env.root, "fake-home", "clean-target.md");
    const repo = await createMockSkillRepo(env.root, {
      name: "CleanVarPkg",
      files: [{ source: "files/x.md", target, content: "hi\n" }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe("provides.files — arc#420 occupied-target refusal", () => {
  test("refuses when the target already exists as real, non-owned content; content is untouched", async () => {
    const target = join(env.root, "fake-home", "skills", "website-oracle-provided");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "MINE.md"), "operator content\n");

    const repo = await createMockSkillRepo(env.root, {
      name: "OccupiedPkg",
      files: [{ source: "files/website-oracle", target, content: "packaged\n" }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain(target);
    expect(result.error).toContain("--replace");

    // Operator content is exactly as it was — no sidecar rename, no deletion.
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, "MINE.md"), "utf-8")).toBe("operator content\n");
  });

  test("refuses when the target is a symlink pointing somewhere else (not this package's source)", async () => {
    const target = join(env.root, "fake-home", "skills", "foreign-link");
    const foreignSource = join(env.root, "somewhere-else.md");
    writeFileSync(foreignSource, "foreign\n");
    mkdirSync(join(env.root, "fake-home", "skills"), { recursive: true });
    symlinkSync(foreignSource, target);

    const repo = await createMockSkillRepo(env.root, {
      name: "ForeignLinkPkg",
      files: [{ source: "files/x.md", target, content: "packaged\n" }],
    });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain(target);
    expect(readlinkSync(target)).toBe(foreignSource);
  });

  test("--replace removes the foreign content and installs, with a warning, no backup", async () => {
    const target = join(env.root, "fake-home", "skills", "website-oracle-provided");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "MINE.md"), "operator content\n");

    const repo = await createMockSkillRepo(env.root, {
      name: "ReplacePkg",
      files: [{ source: "files/website-oracle", target, content: "packaged\n" }],
    });

    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      warnings.push(chunk.toString());
      return true;
    };
    let result;
    try {
      result = await install({
        arc: env.arc,
        host: env.host,
        db: env.db,
        repoUrl: repo.url,
        yes: true,
        replaceProvidesFiles: true,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result.success).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    // MINE.md is gone — --replace takes no backup.
    expect(existsSync(join(target, "MINE.md"))).toBe(false);
    expect(existsSync(`${target}.pre-arc`)).toBe(false);
    expect(warnings.some((w) => w.includes(target) && w.toLowerCase().includes("not backed up"))).toBe(true);
  });

  test("an owned symlink from a prior install of the SAME package is updated silently", async () => {
    const target = join(env.root, "fake-home", "skills", "owned-link");
    const repo = await createMockSkillRepo(env.root, {
      name: "OwnedPkg",
      files: [{ source: "files/x.md", target, content: "v1\n" }],
    });

    const first = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    expect(first.success).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    // Re-run createArtifactSymlinks directly against the SAME installDir the
    // DB recorded — this is the shape an upgrade re-applies (paths don't
    // change on `git pull` upgrades). The existing symlink already points at
    // exactly the source this call would use, so it's "owned" — no refusal.
    const row = getSkill(env.db, "OwnedPkg");
    if (!row) throw new Error("expected OwnedPkg to be recorded in the DB");
    const applyAgain = await createArtifactSymlinks({
      type: "skill",
      manifest: {
        name: "OwnedPkg",
        version: "1.0.0",
        type: "skill",
        provides: { files: [{ source: "files/x.md", target }] },
      } as any,
      arc: env.arc,
      host: env.host,
      installDir: row.install_path,
    });

    expect(applyAgain.filesOccupied).toHaveLength(0);
    expect(applyAgain.unsafeTargets).toHaveLength(0);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
  });
});
