import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "fs/promises";
import { existsSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { classifyTargetOccupancy } from "../../src/lib/artifact-installer.js";
import {
  backupSkillTarget,
  diffSkillTarget,
  needsPager,
  parseOnConflict,
  promptSkillConflict,
  restoreSkillBackup,
  skillConflictResolver,
  somaSkillSlot,
  type SkillConflict,
  type SkillConflictIO,
} from "../../src/lib/skill-conflict.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "arc-skill-conflict-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function scriptedIO(answers: (string | null)[], diffText = "--- a\n+++ b\n") {
  const queue = [...answers];
  const out: string[] = [];
  const paged: string[] = [];
  const diffs: [string, string][] = [];
  const io: SkillConflictIO = {
    read: () => Promise.resolve(queue.length ? (queue.shift() ?? null) : null),
    write: (text) => out.push(text),
    diff: (existing, packageDir) => {
      diffs.push([existing, packageDir]);
      return diffText;
    },
    page: (text) => {
      paged.push(text);
      return Promise.resolve();
    },
    home: "/home/op",
  };
  return { io, out, paged, diffs, remaining: queue };
}

const conflict: SkillConflict = {
  name: "research",
  target: "/home/op/.soma/skills/research",
  source: "/repos/pack/skill",
};

describe("classifyTargetOccupancy (soma-lifeos#17 seam)", () => {
  test("absent when nothing sits at the target", () => {
    expect(classifyTargetOccupancy(join(root, "skills", "x"), join(root, "pkg"))).toBe("absent");
  });

  test("owned when the target is arc's own symlink to the package source", async () => {
    await mkdir(join(root, "pkg"), { recursive: true });
    await mkdir(join(root, "skills"), { recursive: true });
    await symlink(join(root, "pkg"), join(root, "skills", "x"));
    expect(classifyTargetOccupancy(join(root, "skills", "x"), join(root, "pkg"))).toBe("owned");
  });

  test("occupied by a real directory, a file, or a foreign symlink", async () => {
    await mkdir(join(root, "skills", "dir"), { recursive: true });
    await writeFile(join(root, "skills", "file"), "x");
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(root, "skills", "link"));
    const source = join(root, "pkg");
    expect(classifyTargetOccupancy(join(root, "skills", "dir"), source)).toBe("occupied");
    expect(classifyTargetOccupancy(join(root, "skills", "file"), source)).toBe("occupied");
    expect(classifyTargetOccupancy(join(root, "skills", "link"), source)).toBe("occupied");
  });
});

describe("promptSkillConflict", () => {
  test("prints the apt-style prompt with the target shortened to ~", async () => {
    const { io, out } = scriptedIO(["k"]);
    await promptSkillConflict(conflict, io);
    expect(out.join("")).toBe(
      "Skill 'research' already exists at ~/.soma/skills/research (not installed by arc).\n" +
        "  [r] replace it with the package's version (yours is kept as a backup)\n" +
        "  [k] keep yours and skip this skill\n" +
        "  [d] show the differences, then ask again\n" +
        "Choice [k]: ",
    );
  });

  test("r replaces, k keeps, Enter keeps", async () => {
    expect(await promptSkillConflict(conflict, scriptedIO(["r"]).io)).toBe("replace");
    expect(await promptSkillConflict(conflict, scriptedIO(["k"]).io)).toBe("keep");
    expect(await promptSkillConflict(conflict, scriptedIO([""]).io)).toBe("keep");
    expect(await promptSkillConflict(conflict, scriptedIO([" R \r"]).io)).toBe("replace");
  });

  test("d pages the diff of existing vs package dir, then asks again", async () => {
    const s = scriptedIO(["d", "r"], "diff -ru a b\n-old\n+new\n");
    expect(await promptSkillConflict(conflict, s.io)).toBe("replace");
    expect(s.diffs).toEqual([[conflict.target, conflict.source]]);
    expect(s.paged).toEqual(["diff -ru a b\n-old\n+new\n"]);
    expect(s.out.filter((t) => t === "Choice [k]: ")).toHaveLength(2);
  });

  test("garbage re-asks instead of choosing", async () => {
    const s = scriptedIO(["yes", "x", "k"]);
    expect(await promptSkillConflict(conflict, s.io)).toBe("keep");
    expect(s.out.filter((t) => t === "Please answer r, k or d.\n")).toHaveLength(2);
    expect(s.remaining).toHaveLength(0);
  });

  test("end of input keeps", async () => {
    expect(await promptSkillConflict(conflict, scriptedIO([null]).io)).toBe("keep");
  });
});

describe("skillConflictResolver", () => {
  test("no terminal and no --on-conflict refuses", async () => {
    expect(await skillConflictResolver({ interactive: false })(conflict)).toBe("refuse");
  });

  test("--on-conflict replace|keep answers without asking, with or without a terminal", async () => {
    const s = scriptedIO([]);
    for (const interactive of [true, false]) {
      expect(await skillConflictResolver({ onConflict: "replace", interactive, io: s.io })(conflict)).toBe("replace");
      expect(await skillConflictResolver({ onConflict: "keep", interactive, io: s.io })(conflict)).toBe("keep");
    }
    expect(s.out).toHaveLength(0);
  });

  test("an interactive terminal is asked", async () => {
    const s = scriptedIO(["r"]);
    expect(await skillConflictResolver({ interactive: true, io: s.io })(conflict)).toBe("replace");
    expect(s.out.join("")).toContain("[r] replace");
  });
});

describe("somaSkillSlot", () => {
  test("follows $SOMA_HOME, else ~/.soma", () => {
    expect(somaSkillSlot("research", { SOMA_HOME: "/srv/soma" })).toBe("/srv/soma/skills/research");
    expect(somaSkillSlot("research", {})).toBe(join(process.env.HOME!, ".soma", "skills", "research"));
  });
});

describe("parseOnConflict", () => {
  test("accepts replace and keep, rejects anything else", () => {
    expect(parseOnConflict(undefined)).toBeUndefined();
    expect(parseOnConflict("replace")).toBe("replace");
    expect(parseOnConflict("keep")).toBe("keep");
    expect(() => parseOnConflict("merge")).toThrow("--on-conflict must be 'replace' or 'keep'");
  });
});

describe("needsPager", () => {
  test("pages only output longer than the terminal", () => {
    expect(needsPager("a\nb\n", 24)).toBe(false);
    expect(needsPager("x\n".repeat(25), 24)).toBe(true);
    expect(needsPager("x\n".repeat(25), undefined)).toBe(false);
  });
});

describe("diffSkillTarget", () => {
  test("is a recursive unified diff of the existing path against the package dir", async () => {
    await mkdir(join(root, "mine", "sub"), { recursive: true });
    await mkdir(join(root, "pkg", "sub"), { recursive: true });
    await writeFile(join(root, "mine", "SKILL.md"), "old line\n");
    await writeFile(join(root, "pkg", "SKILL.md"), "new line\n");
    await writeFile(join(root, "pkg", "sub", "extra.md"), "x\n");
    const diff = diffSkillTarget(join(root, "mine"), join(root, "pkg"));
    expect(diff).toContain(`diff -ru ${join(root, "mine", "SKILL.md")} ${join(root, "pkg", "SKILL.md")}`);
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
    expect(diff).toContain(`Only in ${join(root, "pkg", "sub")}: extra.md`);
  });

  test("says so when there is no difference", async () => {
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    expect(diffSkillTarget(join(root, "a"), join(root, "b"))).toBe("No differences.\n");
  });
});

describe("backupSkillTarget / restoreSkillBackup", () => {
  test("moves the target to <stateRoot>/backups/<timestamp>/<skill> and back", async () => {
    const target = join(root, "skills", "research");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "mine\n");
    const stateRoot = join(root, "state");

    const backup = await backupSkillTarget(target, "research", stateRoot, new Date("2026-10-28T12:00:00.000Z"));
    expect(backup).toBe(join(stateRoot, "backups", "2026-10-28T12-00-00-000Z", "research"));
    expect(existsSync(target)).toBe(false);
    expect(await readFile(join(backup, "SKILL.md"), "utf-8")).toBe("mine\n");

    await restoreSkillBackup(backup, target);
    expect(await readFile(join(target, "SKILL.md"), "utf-8")).toBe("mine\n");
    expect(existsSync(backup)).toBe(false);
  });

  test("a second backup in the same instant never clobbers the first", async () => {
    const stateRoot = join(root, "state");
    const now = new Date("2026-10-28T12:00:00.000Z");
    for (const n of [1, 2]) {
      await mkdir(join(root, `s${n}`, "x"), { recursive: true });
    }
    const first = await backupSkillTarget(join(root, "s1", "x"), "x", stateRoot, now);
    const second = await backupSkillTarget(join(root, "s2", "x"), "x", stateRoot, now);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test("keeps a foreign symlink a symlink", async () => {
    await mkdir(join(root, "elsewhere"), { recursive: true });
    const target = join(root, "skills", "x");
    await mkdir(join(root, "skills"), { recursive: true });
    await symlink(join(root, "elsewhere"), target);
    const backup = await backupSkillTarget(target, "x", join(root, "state"));
    expect(lstatSync(backup).isSymbolicLink()).toBe(true);
  });

  test("restore refuses to overwrite an occupied target", async () => {
    await mkdir(join(root, "backup"), { recursive: true });
    await mkdir(join(root, "target"), { recursive: true });
    let message = "";
    try {
      await restoreSkillBackup(join(root, "backup"), join(root, "target"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("is occupied");
  });
});
