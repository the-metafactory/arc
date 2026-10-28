/**
 * soma-lifeos#17 through the real `arc install` command: a subprocess with a
 * temp HOME and a piped (non-TTY) stdin, so `--yes` and `--on-conflict` are
 * parsed and wired exactly as an operator's shell would.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { lstatSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMockSkillRepo } from "../helpers/test-env.js";
import { spawnEnv } from "../../src/lib/user-home.js";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
let home: string;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

function arc(args: string[]) {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...spawnEnv(),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      SOMA_HOME: join(home, ".soma"),
      NODE_ENV: "test",
    },
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

async function setup(): Promise<{ url: string; mine: string }> {
  home = await mkdtemp(join(tmpdir(), "arc-skill-conflict-cli-"));
  const repo = await createMockSkillRepo(join(home, "src"), { name: "research" });
  const mine = join(home, ".claude", "skills", "research");
  await mkdir(mine, { recursive: true });
  await writeFile(join(mine, "SKILL.md"), "# my own copy\n");
  return { url: `file://${repo.path}`, mine };
}

describe("arc install with an occupied skill and no terminal", () => {
  test("--yes alone refuses and names the target", async () => {
    const { url, mine } = await setup();
    const r = arc(["install", url, "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Skill 'research' already exists at ${mine} (not installed by arc)`);
    expect(lstatSync(mine).isDirectory()).toBe(true);
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toBe("# my own copy\n");
  }, 120_000);

  test("--on-conflict keep installs as kept and arc list shows it", async () => {
    const { url, mine } = await setup();
    const r = arc(["install", url, "--yes", "--on-conflict", "keep"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Kept your own 'research' skill");
    expect(lstatSync(mine).isDirectory()).toBe(true);
    const listed = arc(["list"]);
    expect(listed.out).toContain("research v1.0.0 [kept]");
  }, 120_000);

  test("--on-conflict rejects anything but replace or keep", async () => {
    await setup();
    const r = arc(["install", "file:///nowhere", "--yes", "--on-conflict", "merge"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--on-conflict must be 'replace' or 'keep' (got 'merge')");
  }, 120_000);
});
