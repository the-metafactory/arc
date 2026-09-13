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
import { upgradeAll, upgradePackage } from "../../src/commands/upgrade.js";
import { createArtifactSymlinks } from "../../src/lib/artifact-installer.js";
import { getSkill } from "../../src/lib/db.js";
import YAML from "yaml";

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

/**
 * arc#421 round 2 (BLOCKER): the SAME two guards on the `arc upgrade` path.
 *
 * `upgradePackage` re-drops `provides.files` for `type: component` and
 * `type: governance` (arc#361 — a governance package's ENTIRE payload is
 * provides.files, so without the re-drop a drop added between versions never
 * lands). That re-drop used to call `resolveProvidesTarget` + `createSymlink`
 * directly, bypassing `planArtifactSymlinks` — so on upgrade BOTH defects
 * reproduced verbatim at exit 0 with an empty stderr: a `$FOO` target created
 * a literal `$FOO` directory relative to cwd, and an operator's directory was
 * silently displaced to a `.pre-arc` sidecar. compass ships as
 * `type: governance`, so this is its NORMAL upgrade path.
 */
describe("provides.files — the same guards on the arc upgrade re-drop (arc#421)", () => {
  /** Build a governance package (compass-core's shape) at `version`. */
  async function writeGovManifest(
    repoDir: string,
    version: string,
    files: { source: string; target: string }[],
  ): Promise<void> {
    await Bun.write(
      join(repoDir, "arc-manifest.yaml"),
      YAML.stringify({
        name: "GovPkg",
        version,
        type: "governance",
        tier: "custom",
        description: "Mock governance engine (compass-core shape)",
        author: { name: "tester", github: "tester" },
        provides: { files },
        depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
        capabilities: {
          filesystem: { read: [], write: [] },
          network: [],
          bash: { allowed: false },
          secrets: [],
        },
      }),
    );
  }

  function git(cwd: string, args: string[]): void {
    Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /**
   * Install GovPkg v1 with ONE clean drop, then rewrite its manifest to v2
   * with whatever `v2Files` describes and commit. Returns the v1 drop target
   * so a caller can assert the previous version survived a refusal.
   */
  async function installV1ThenStageV2(
    v2Files: { source: string; target: string }[],
  ): Promise<{ repoDir: string; v1Target: string }> {
    const repoDir = join(env.root, "mock-GovPkg");
    mkdirSync(join(repoDir, "claude", "skills", "governance"), { recursive: true });
    writeFileSync(join(repoDir, "claude", "skills", "governance", "SKILL.md"), "# gov\n");
    mkdirSync(join(repoDir, "claude", "agents"), { recursive: true });
    writeFileSync(join(repoDir, "claude", "agents", "governance.md"), "# agent\n");
    writeFileSync(join(repoDir, "added-in-v2.md"), "packaged v2\n");

    const v1Target = join(env.root, "fake-home", "gov-skill");
    await writeGovManifest(repoDir, "1.0.0", [
      { source: "claude/skills/governance", target: v1Target },
    ]);
    git(repoDir, ["init"]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "v1"]);

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repoDir,
      yes: true,
    });
    expect(installed.success).toBe(true);
    expect(lstatSync(v1Target).isSymbolicLink()).toBe(true);

    await writeGovManifest(repoDir, "2.0.0", [
      { source: "claude/skills/governance", target: v1Target },
      ...v2Files,
    ]);
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "v2"]);

    return { repoDir, v1Target };
  }

  test("arc#419 — an unexpanded $VAR target added in v2 is refused on upgrade; nothing is created", async () => {
    const { v1Target } = await installV1ThenStageV2([
      { source: "added-in-v2.md", target: "$FOO/skills/website-oracle" },
    ]);

    const cwdBefore = process.cwd();
    const result = await upgradePackage(env.db, env.arc, env.host, "GovPkg");

    expect(result.success).toBe(false);
    expect(result.error).toContain("$FOO");
    expect(result.error).toContain("unexpanded variable");
    // The literal `$FOO` directory relative to cwd — the arc#419 bug, which
    // reproduced verbatim on this path before the fix.
    expect(existsSync(join(cwdBefore, "$FOO"))).toBe(false);

    // Coherent state: the PREVIOUS version is still installed, its drop still
    // resolves, and the DB row was not bumped.
    const row = getSkill(env.db, "GovPkg");
    expect(row?.version).toBe("1.0.0");
    expect(row?.status).toBe("active");
    expect(lstatSync(v1Target).isSymbolicLink()).toBe(true);
    expect(existsSync(join(v1Target, "SKILL.md"))).toBe(true);
  });

  test("arc#420 — a target occupied by operator content is refused on upgrade; the content is untouched", async () => {
    const occupied = join(env.root, "fake-home", "operator-dir");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "MINE.md"), "operator content\n");

    const { v1Target } = await installV1ThenStageV2([
      { source: "claude/agents/governance.md", target: occupied },
    ]);

    const result = await upgradePackage(env.db, env.arc, env.host, "GovPkg");

    expect(result.success).toBe(false);
    expect(result.error).toContain(occupied);
    expect(result.error).toContain("--replace");

    // No sidecar rename, no deletion — the exact failure the old path had.
    expect(lstatSync(occupied).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(occupied, "MINE.md"), "utf-8")).toBe("operator content\n");
    expect(existsSync(`${occupied}.pre-arc`)).toBe(false);

    const row = getSkill(env.db, "GovPkg");
    expect(row?.version).toBe("1.0.0");
    expect(lstatSync(v1Target).isSymbolicLink()).toBe(true);
  });

  test("arc#420 — `arc upgrade --replace` removes the occupied content, warns, takes no backup", async () => {
    const occupied = join(env.root, "fake-home", "operator-dir");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "MINE.md"), "operator content\n");

    await installV1ThenStageV2([
      { source: "claude/agents/governance.md", target: occupied },
    ]);

    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      warnings.push(chunk.toString());
      return true;
    };
    let result;
    try {
      result = await upgradePackage(env.db, env.arc, env.host, "GovPkg", {
        replaceProvidesFiles: true,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("2.0.0");
    expect(lstatSync(occupied).isSymbolicLink()).toBe(true);
    expect(existsSync(`${occupied}.pre-arc`)).toBe(false);
    expect(
      warnings.some((w) => w.includes(occupied) && w.toLowerCase().includes("not backed up")),
    ).toBe(true);
  });

  test("an OWNED symlink from the previous version is updated silently — the ordinary upgrade still works", async () => {
    // v2 changes nothing but the version: the v1 drop target is already a
    // symlink pointing at exactly the source v2 will link there. That is the
    // whole point of the re-drop, and it must NOT be refused as "occupied".
    const { v1Target } = await installV1ThenStageV2([]);

    const warnings: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      warnings.push(chunk.toString());
      return true;
    };
    let result;
    try {
      result = await upgradePackage(env.db, env.arc, env.host, "GovPkg");
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("2.0.0");
    expect(lstatSync(v1Target).isSymbolicLink()).toBe(true);
    expect(existsSync(join(v1Target, "SKILL.md"))).toBe(true);
    expect(getSkill(env.db, "GovPkg")?.version).toBe("2.0.0");
    // Silent: no provides.files warning on the ordinary upgrade path.
    expect(warnings.join("")).not.toContain("not backed up");
  });

  test("a NEW clean drop added in v2 lands on upgrade (the re-drop still does its job)", async () => {
    const newTarget = join(env.root, "fake-home", "added-in-v2.md");
    await installV1ThenStageV2([{ source: "added-in-v2.md", target: newTarget }]);

    const result = await upgradePackage(env.db, env.arc, env.host, "GovPkg");

    expect(result.success).toBe(true);
    expect(existsSync(newTarget)).toBe(true);
    expect(readFileSync(newTarget, "utf-8")).toBe("packaged v2\n");
  });

  // -------------------------------------------------------------------------
  // arc#421 round 2 (MINOR): `arc upgrade --replace` with no package name.
  //
  // `upgradeAll`'s non-force branch passed `{ _seen: seen }` and threw `opts`
  // away, so the bulk path silently behaved differently from the single-package
  // path: the flag was accepted by the CLI, then never reached
  // `upgradePackage`, and the refusal told the operator to pass the flag they
  // had just passed. The force branch spread `opts` correctly, which is why it
  // went unnoticed.
  //
  // These two pin BOTH sides of the difference — drop the spread again and the
  // first reds.
  // -------------------------------------------------------------------------

  async function occupiedV2(): Promise<string> {
    const occupied = join(env.root, "fake-home", "operator-dir");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "MINE.md"), "operator content\n");
    await installV1ThenStageV2([
      { source: "claude/agents/governance.md", target: occupied },
    ]);
    return occupied;
  }

  test("`arc upgrade --replace` (no package name) threads the flag through upgradeAll", async () => {
    const occupied = await occupiedV2();

    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let results;
    try {
      results = await upgradeAll(env.db, env.arc, env.host, { replaceProvidesFiles: true });
    } finally {
      process.stderr.write = originalWrite;
    }

    const gov = results.find((r) => r.name === "GovPkg");
    expect(gov?.error ?? "").not.toContain("--replace");
    expect(gov?.success).toBe(true);
    expect(gov?.newVersion).toBe("2.0.0");
    expect(lstatSync(occupied).isSymbolicLink()).toBe(true);
  });

  test("`arc upgrade` without --replace still refuses through upgradeAll (the control)", async () => {
    const occupied = await occupiedV2();

    const results = await upgradeAll(env.db, env.arc, env.host, {});

    const gov = results.find((r) => r.name === "GovPkg");
    expect(gov?.success).toBe(false);
    expect(gov?.error).toContain(occupied);
    expect(gov?.error).toContain("--replace");
    expect(lstatSync(occupied).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(occupied, "MINE.md"), "utf-8")).toBe("operator content\n");
  });
});
