/**
 * soma-lifeos#17 — arc asks before replacing an existing skill. Drives the
 * real install path (createTestEnv roots every arc and host path in a temp
 * dir) with an injected resolver standing in for the terminal.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "fs";
import { mkdir, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { install } from "../../src/commands/install.js";
import { list, formatList } from "../../src/commands/list.js";
import { remove } from "../../src/commands/remove.js";
import { enable } from "../../src/commands/enable.js";
import { getSkill } from "../../src/lib/db.js";
import { upgradeLibrary } from "../../src/commands/upgrade.js";
import { installFakeSoma } from "../helpers/fake-soma.js";
import { ArtifactInstallState } from "../../src/lib/install-transaction.js";
import type { SkillConflict, SkillConflictResolver, SkillConflictChoice } from "../../src/lib/skill-conflict.js";
import { createTestEnv, createMockLibraryRepo, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

let env: TestEnv;
let originalSomaHome: string | undefined;

beforeEach(() => {
  originalSomaHome = process.env.SOMA_HOME;
});

afterEach(async () => {
  if (originalSomaHome === undefined) delete process.env.SOMA_HOME;
  else process.env.SOMA_HOME = originalSomaHome;
  if (env) await env.cleanup();
});

async function newEnv(): Promise<TestEnv> {
  env = await createTestEnv();
  process.env.SOMA_HOME = join(env.root, ".soma");
  return env;
}

function recordingResolver(choice: SkillConflictChoice | "refuse") {
  const asked: SkillConflict[] = [];
  const resolver: SkillConflictResolver = (conflict) => {
    asked.push(conflict);
    return Promise.resolve(choice);
  };
  return { asked, resolver };
}

async function handMadeSkill(name: string): Promise<string> {
  const dir = join(env.host.paths.skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# my own copy\n");
  return dir;
}

function backupsRoot(): string {
  return join(env.arc.stateRoot, "backups");
}

describe("occupied skill target (soma-lifeos#17)", () => {
  test("no resolver (no terminal, no --on-conflict) refuses, names the target, and writes nothing", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const mine = await handMadeSkill("research");

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`Skill 'research' already exists at ${mine} (not installed by arc)`);
    expect(result.error).toContain("--on-conflict replace|keep");
    expect(lstatSync(mine).isDirectory()).toBe(true);
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    expect(existsSync(`${mine}.pre-arc`)).toBe(false);
    expect(getSkill(env.db, "research")).toBeNull();
  });

  test("keep leaves the directory, records the skill as kept, and arc list shows it as kept", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const mine = await handMadeSkill("research");
    const { asked, resolver } = recordingResolver("keep");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(result.kept).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ name: "research", target: mine });
    expect(asked[0].source).toBe(join(env.arc.reposDir, "mock-research", "skill"));
    expect(lstatSync(mine).isDirectory()).toBe(true);
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    expect(existsSync(`${mine}.pre-arc`)).toBe(false);
    expect(getSkill(env.db, "research")?.status).toBe("kept");
    expect(formatList(list(env.db))).toContain("⏭️ research v1.0.0 [kept]");
  });

  test("replace moves the existing path to <stateRoot>/backups/<timestamp>/<skill> and links the package", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const mine = await handMadeSkill("research");
    const { resolver } = recordingResolver("replace");
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    let result;
    try {
      result = await install({
        arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
      });
    } finally {
      console.log = origLog;
    }

    expect(result.success).toBe(true);
    expect(result.kept).toBeUndefined();
    expect(lstatSync(mine).isSymbolicLink()).toBe(true);
    expect(readlinkSync(mine)).toBe(join(env.arc.reposDir, "mock-research", "skill"));
    const stamps = readdirSync(backupsRoot());
    expect(stamps).toHaveLength(1);
    const backup = join(backupsRoot(), stamps[0], "research");
    expect(readFileSync(join(backup, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    expect(backup.startsWith(env.host.paths.skillsDir)).toBe(false);
    expect(logged.join("\n")).toContain(backup);
    expect(getSkill(env.db, "research")?.status).toBe("active");
  });

  test("a rolled-back replace puts the principal's directory back", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, {
      name: "research",
      scripts: { postinstall: { path: "scripts/postinstall.sh", content: "#!/usr/bin/env bash\nexit 1\n" } },
    });
    const mine = await handMadeSkill("research");
    const { resolver } = recordingResolver("replace");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(false);
    expect(lstatSync(mine).isDirectory()).toBe(true);
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    const stamps = readdirSync(backupsRoot());
    expect(readdirSync(join(backupsRoot(), stamps[0]))).toEqual([]);
  });

  test("a foreign symlink is a conflict too; keep leaves it and remove does not unlink it", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const elsewhere = join(env.root, "soma-home", "research");
    await mkdir(elsewhere, { recursive: true });
    const target = join(env.host.paths.skillsDir, "research");
    await symlink(elsewhere, target);
    const { asked, resolver } = recordingResolver("keep");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });
    expect(result.success).toBe(true);
    expect(asked).toHaveLength(1);
    expect(readlinkSync(target)).toBe(elsewhere);

    const enabled = await enable(env.db, env.arc, env.host, "research");
    expect(enabled.success).toBe(false);
    expect(readlinkSync(target)).toBe(elsewhere);

    const removed = await remove(env.db, env.arc, env.host, "research");
    expect(removed.success).toBe(true);
    expect(readlinkSync(target)).toBe(elsewhere);
  });

  test("an owned target (arc's own link for the same package) is replaced silently", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const target = join(env.host.paths.skillsDir, "research");
    const source = join(env.arc.reposDir, "mock-research", "skill");
    await symlink(source, target);
    const { asked, resolver } = recordingResolver("refuse");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(asked).toHaveLength(0);
    expect(readlinkSync(target)).toBe(source);
    expect(existsSync(backupsRoot())).toBe(false);
  });

  test("a tool's occupied bin target keeps the arc#293 sidecar behavior and never asks", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "lucid", type: "tool" });
    const bin = join(env.host.paths.binDir, "lucid");
    await mkdir(env.host.paths.binDir, { recursive: true });
    await writeFile(bin, "#!/bin/sh\necho legacy\n");
    const { asked, resolver } = recordingResolver("refuse");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(asked).toHaveLength(0);
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${bin}.pre-arc`, "utf-8")).toBe("#!/bin/sh\necho legacy\n");
  });
});

describe("library install with an occupied skill (soma-lifeos#17)", () => {
  test("keep skips only that skill; the other members install and the journal records kept", async () => {
    await newEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "pack",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/research", name: "research", type: "skill" },
        { path: "skills/omega", name: "omega", type: "skill" },
      ],
    });
    const mine = await handMadeSkill("research");
    const { asked, resolver } = recordingResolver("keep");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(asked.map((c) => c.name)).toEqual(["research"]);
    expect(lstatSync(mine).isDirectory()).toBe(true);
    for (const name of ["alpha", "omega"]) {
      expect(lstatSync(join(env.host.paths.skillsDir, name)).isSymbolicLink()).toBe(true);
      expect(getSkill(env.db, name)?.status).toBe("active");
    }
    expect(getSkill(env.db, "research")?.status).toBe("kept");
    const states = Object.fromEntries(result.journal!.artifacts.map((a) => [a.name, a.state]));
    expect(states).toEqual({
      alpha: ArtifactInstallState.SUCCESS,
      research: ArtifactInstallState.KEPT,
      omega: ArtifactInstallState.SUCCESS,
    });
    expect(result.artifacts!.find((a) => a.name === "research")?.kept).toBe(true);
  });

  test("a refused skill rolls back the members that landed before it", async () => {
    await newEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "pack",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/research", name: "research", type: "skill" },
      ],
    });
    const mine = await handMadeSkill("research");

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`Skill 'research' already exists at ${mine}`);
    expect(existsSync(join(env.host.paths.skillsDir, "alpha"))).toBe(false);
    expect(getSkill(env.db, "alpha")).toBeNull();
    expect(lstatSync(mine).isDirectory()).toBe(true);
  });

  test("a kept member rolled back by a later failure leaves the principal's directory alone", async () => {
    await newEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "pack",
      artifacts: [
        { path: "skills/research", name: "research", type: "skill" },
        {
          path: "skills/broken",
          name: "broken",
          type: "skill",
          postinstall: { path: "scripts/postinstall.sh", content: "#!/usr/bin/env bash\nexit 1\n" },
        },
      ],
    });
    const mine = await handMadeSkill("research");
    const { resolver } = recordingResolver("keep");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(false);
    expect(lstatSync(mine).isDirectory()).toBe(true);
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    expect(getSkill(env.db, "research")).toBeNull();
  });
});

describe("the Soma registry slot (soma-lifeos#17)", () => {
  async function somaOwnedSkill(name: string): Promise<{ registry: string; host: string }> {
    const registry = join(process.env.SOMA_HOME!, "skills", name);
    await mkdir(registry, { recursive: true });
    await writeFile(join(registry, "SKILL.md"), "# my own copy\n");
    const host = join(env.host.paths.skillsDir, name);
    await symlink(registry, host);
    return { registry, host };
  }

  test("a real directory in ~/.soma/skills behind Soma's loader link is asked about once, naming the directory", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const { registry, host } = await somaOwnedSkill("research");
    const { asked, resolver } = recordingResolver("keep");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].target).toBe(registry);
    expect(readlinkSync(host)).toBe(registry);
    expect(readFileSync(join(registry, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    expect(getSkill(env.db, "research")?.status).toBe("kept");
  });

  test("replace backs up both the directory and the loader link, and links the package", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const { host } = await somaOwnedSkill("research");
    const { resolver } = recordingResolver("replace");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(readlinkSync(host)).toBe(join(env.arc.reposDir, "mock-research", "skill"));
    const backups = readdirSync(backupsRoot()).map((stamp) => join(backupsRoot(), stamp, "research"));
    expect(backups).toHaveLength(2);
    const dirBackup = backups.find((b) => lstatSync(b).isDirectory());
    expect(readFileSync(join(dirBackup!, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    expect(existsSync(join(process.env.SOMA_HOME!, "skills", "research"))).toBe(false);
  });

  test("arc's own skill seen through Soma's projection chain is not a conflict", async () => {
    await newEnv();
    const repo = await createMockSkillRepo(env.root, { name: "research" });
    const source = join(env.arc.reposDir, "mock-research", "skill");
    const registry = join(process.env.SOMA_HOME!, "skills", "research");
    await mkdir(join(process.env.SOMA_HOME!, "skills"), { recursive: true });
    await symlink(source, registry);
    await symlink(registry, join(env.host.paths.skillsDir, "research"));
    const { asked, resolver } = recordingResolver("refuse");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
    });

    expect(result.success).toBe(true);
    expect(asked).toHaveLength(0);
  });
});

describe("a kept skill lands nothing (soma-lifeos#17)", () => {
  test("no postinstall, no Soma projection on install, no Soma unproject on remove", async () => {
    await newEnv();
    const marker = join(env.root, "postinstall-ran");
    const repo = await createMockSkillRepo(env.root, {
      name: "research",
      scripts: { postinstall: { path: "scripts/postinstall.sh", content: `#!/usr/bin/env bash\ntouch "${marker}"\n` } },
    });
    const fake = await installFakeSoma({
      root: env.root,
      shimDir: env.arc.shimDir,
      scriptForCallsPath: (path) => `#!/bin/sh\necho "$@" >> "${path}"\nexit 0\n`,
    });
    try {
      const mine = await handMadeSkill("research");
      const { resolver } = recordingResolver("keep");
      const result = await install({
        arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, onSkillConflict: resolver,
      });
      expect(result.kept).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(fake.callsPath)).toBe(false);

      const removed = await remove(env.db, env.arc, env.host, "research");
      expect(removed.success).toBe(true);
      expect(existsSync(fake.callsPath)).toBe(false);
      expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
    } finally {
      fake.restore();
    }
  });

  test("a library re-run skips a kept member without asking again", async () => {
    await newEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "pack",
      artifacts: [{ path: "skills/research", name: "research", type: "skill" }],
    });
    await handMadeSkill("research");
    const first = recordingResolver("keep");
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true, onSkillConflict: first.resolver });
    expect(getSkill(env.db, "research")?.status).toBe("kept");

    const again = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true });
    expect(again.success).toBe(true);
    expect(again.journal!.artifacts.map((a) => a.state)).toEqual([ArtifactInstallState.SKIPPED]);
    expect(getSkill(env.db, "research")?.status).toBe("kept");
  });
});

describe("arc upgrade linking a new library skill (soma-lifeos#17)", () => {
  async function libraryWithNewArtifact() {
    const lib = await createMockLibraryRepo(env.root, {
      name: "pack",
      artifacts: [{ path: "skills/alpha", name: "alpha", type: "skill" }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: lib.url, yes: true });
    const dir = join(lib.path, "skills", "research");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "schema: arc/v1", "name: research", "version: 1.0.0", "type: skill",
        "author:", "  name: testuser", "  github: testuser",
        "provides:", "  skill:", "    - trigger: research",
        "capabilities:", "  filesystem:", "    read:", '      - "./"', "    write: []",
        "  network: []", "  bash:", "    allowed: false", "  secrets: []",
      ].join("\n"),
    );
    await Bun.write(join(dir, "skill", "SKILL.md"), "# research\n");
    const rootManifest = join(lib.path, "arc-manifest.yaml");
    const text = await Bun.file(rootManifest).text();
    await Bun.write(rootManifest, text.replace("artifacts:\n", "artifacts:\n  - path: skills/research\n    description: research\n"));
    for (const args of [["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-m", "add research"]]) {
      Bun.spawnSync(["git", ...args], { cwd: lib.path, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    }
  }

  test("without a choice the new skill is refused, naming the target", async () => {
    await newEnv();
    await libraryWithNewArtifact();
    const mine = await handMadeSkill("research");

    const results = await upgradeLibrary(env.db, env.arc, env.host, "pack");

    const research = results.find((r) => r.name === "research");
    expect(research?.success).toBe(false);
    expect(research?.error).toContain(`Skill 'research' already exists at ${mine}`);
    expect(lstatSync(mine).isDirectory()).toBe(true);
  });

  test("--on-conflict keep records it as kept", async () => {
    await newEnv();
    await libraryWithNewArtifact();
    const mine = await handMadeSkill("research");
    const { asked, resolver } = recordingResolver("keep");

    const results = await upgradeLibrary(env.db, env.arc, env.host, "pack", { onSkillConflict: resolver });

    expect(results.find((r) => r.name === "research")?.success).toBe(true);
    expect(asked).toHaveLength(1);
    expect(lstatSync(mine).isDirectory()).toBe(true);
    expect(getSkill(env.db, "research")?.status).toBe("kept");
  });
});

describe("a dependency the principal kept (soma-lifeos#17)", () => {
  test("satisfies the dependent but is warned about, even under --yes", async () => {
    await newEnv();
    const dep = await createMockSkillRepo(env.root, { name: "research" });
    await handMadeSkill("research");
    const { resolver } = recordingResolver("keep");
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: dep.url, yes: true, onSkillConflict: resolver });
    const parent = await createMockSkillRepo(env.root, {
      name: "writer",
      dependsOnPackages: [{ name: "research", repo: dep.url }],
    });
    const errors: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });
    let result;
    try {
      result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result.success).toBe(true);
    expect(errors.join("")).toContain("depends on 'research', which is kept");
    expect(getSkill(env.db, "research")?.status).toBe("kept");
  });
});
