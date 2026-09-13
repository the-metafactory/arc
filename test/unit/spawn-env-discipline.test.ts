/**
 * The class guard for arc#421's leak: **no process is spawned without an
 * explicit `env`, unless the program it runs provably cannot reach the
 * operator's home.**
 *
 * Round 3 fixed two spawn sites by hand (real `cosign` writing `~/.sigstore`,
 * real `nsc` writing `~/.config/nats/nsc/nsc.json`). Round 4's confirmation
 * then inventoried the repository and found 334 spawn sites, 9 with an `env`
 * and 325 without — including `soma project-skill --apply` (whose entire job
 * is writing `~/.soma` and projecting into `~/.claude`, on every `type: skill`
 * install) and `bun install` (measured: 290 entries written into the
 * spawn-time home's module cache during one suite run). Two instances had been
 * closed; the class had not.
 *
 * So this file does not check a list of known-bad sites. It inverts the
 * default: EVERY spawn must say something about the child's environment, and
 * the only way to say nothing is to run a program on the allowlist below,
 * each entry of which carries its reason.
 *
 * ── Why an allowlist keyed on the PROGRAM ───────────────────────────────────
 *
 * A file/line allowlist rots on the next edit and says nothing about why a
 * site is safe. The real question is what the child does, so the exemption is
 * keyed on what is being run — and a site whose argv head is COMPUTED can
 * never be exempted, because nobody can say what it runs. That is the exact
 * shape of four of the five sites this round had to fix.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectSpawnSites, scanSource, type SpawnSite } from "../helpers/spawn-inventory.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCANNED_DIRS = ["src", "test", "scripts", "bin"] as const;

/**
 * Programs that may be spawned with no `env`, and why each one cannot carry
 * the leak. One line per entry, and the line has to be true.
 */
const LEAK_FREE_PROGRAMS: Readonly<Record<string, string>> = {
  git: "operates on the repo path it is given; touches home only via `config --global|--system`, refused below",
  rm: "deletes the paths it is given; no home-rooted state of its own",
  mv: "moves the paths it is given; no home-rooted state of its own",
  cp: "copies the paths it is given; no home-rooted state of its own",
  chmod: "changes the mode of the paths it is given; no home-rooted state of its own",
  tar: "reads/writes the archive and directory it is given; no home-rooted state of its own",
  which: "resolves a name against $PATH and prints it; writes nothing",
  loginctl: "queries logind over D-Bus; writes nothing under home",
  security:
    "reaches the macOS login keychain through the Security framework, which no environment variable redirects — out of scope for arc#421 by decision",
};

/** `git` subcommands that DO write to the operator's home. */
const GIT_HOME_WRITING_FLAGS = ["--global", "--system"] as const;

function describeSite(s: SpawnSite): string {
  return `${s.file}:${s.line}  ${s.callee}(…)  ${s.text}`;
}

/**
 * The rule, as a function, so the test below and the red-before proofs share
 * one definition. Returns the reason a site is a violation, or `null`.
 */
export function violationOf(site: SpawnSite): string | null {
  if (site.hasEnv) return null;
  if (site.argvHead === null) {
    return "spawns a COMPUTED command with no explicit `env` — nobody can say what this child does, so it cannot be exempted by name. Pass `env: spawnEnv()`.";
  }
  const reason = LEAK_FREE_PROGRAMS[site.argvHead];
  if (reason === undefined) {
    return `spawns \`${site.argvHead}\` with no explicit \`env\`, and \`${site.argvHead}\` is not on the leak-free allowlist. Pass \`env: spawnEnv()\` (src/lib/user-home.ts), or add \`${site.argvHead}\` to LEAK_FREE_PROGRAMS with a reason that is true.`;
  }
  return null;
}

describe("spawn-env discipline (arc#421 round 4 — the class, not the instances)", () => {
  const sites = collectSpawnSites(REPO_ROOT, SCANNED_DIRS);

  test("the inventory actually finds this repository's spawn sites", () => {
    // A scanner that silently matched nothing would make every assertion below
    // vacuously green. The confirmation counted 334 across src/ and test/.
    expect(sites.length).toBeGreaterThan(300);
    expect(sites.some((s) => s.file.startsWith("src/"))).toBe(true);
    expect(sites.some((s) => s.file.startsWith("test/"))).toBe(true);
  });

  test("every spawn site passes an explicit env, or runs an allowlisted leak-free program", () => {
    const violations = sites
      .map((s) => ({ s, why: violationOf(s) }))
      .filter((v): v is { s: SpawnSite; why: string } => v.why !== null);

    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${describeSite(v.s)}\n      → ${v.why}`).join("\n");
      throw new Error(
        `\n${violations.length} spawn site(s) hand the child the SPAWN-TIME environment.\n` +
          `An in-process $HOME pin is invisible across a process boundary, so such a\n` +
          `child resolves the operator's REAL home no matter what the caller set.\n\n` +
          `${lines}\n`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("no allowlisted `git` spawn writes to the operator's global config", () => {
    // The one way `git` can reach home. Keyed on the source text of the call
    // rather than on the parsed argv, so a flag assembled at the call site
    // still trips it.
    const offenders = sites.filter(
      (s) =>
        !s.hasEnv &&
        s.argvHead === "git" &&
        GIT_HOME_WRITING_FLAGS.some((f) => s.text.includes(f)),
    );
    expect(offenders.map(describeSite)).toEqual([]);
  });

  test("every allowlist entry carries a reason and is actually used", () => {
    for (const reason of Object.values(LEAK_FREE_PROGRAMS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
    // An unused entry is an exemption nobody has justified against real code.
    const spawned = new Set(sites.filter((s) => !s.hasEnv).map((s) => s.argvHead));
    const unused = Object.keys(LEAK_FREE_PROGRAMS).filter((p) => !spawned.has(p));
    expect(unused).toEqual([]);
  });

  test("the five sites this round fixed pass an env", () => {
    // Named explicitly so a revert is a NAMED failure, not just a count change.
    const named: [string, string][] = [
      ["src/lib/soma-projection.ts", "soma project-skill --apply"],
      ["src/lib/artifact-installer.ts", "bun install"],
      ["src/lib/cortex-config-provision.ts", "the cortex runner"],
      ["src/lib/nats-broker.ts", "the broker runner"],
      ["test/unit/node-dependencies.test.ts", "a real bun install"],
    ];
    for (const [file, what] of named) {
      const inFile = sites.filter((s) => s.file === file);
      expect(inFile.length).toBeGreaterThan(0);
      const bare = inFile.filter((s) => violationOf(s) !== null).map(describeSite);
      expect(`${what}: ${bare.join(" | ")}`).toBe(`${what}: `);
    }
  });
});

describe("the spawn scanner itself", () => {
  const scan = (src: string): SpawnSite[] => scanSource("probe.ts", src);

  test("a bare Bun.spawnSync is a violation", () => {
    const [site] = scan(`Bun.spawnSync(["soma", "project-skill"]);`);
    expect(site.hasEnv).toBe(false);
    expect(violationOf(site)).toContain("not on the leak-free allowlist");
  });

  test("an explicit env clears it — property form and shorthand", () => {
    expect(scan(`Bun.spawnSync(["soma"], { env: spawnEnv() });`)[0].hasEnv).toBe(true);
    expect(scan(`Bun.spawnSync(["soma"], { cwd, env });`)[0].hasEnv).toBe(true);
    expect(scan(`Bun.spawn({ cmd: ["soma"], env: spawnEnv() });`)[0].hasEnv).toBe(true);
  });

  test("`env` inside a nested option object still counts as stating one", () => {
    expect(scan(`Bun.spawnSync(["soma"], { ...base, env: { ...process.env } });`)[0].hasEnv).toBe(true);
  });

  test("a substring named env-something does not count", () => {
    const [site] = scan(`Bun.spawnSync(["soma"], { envelope: 1 });`);
    expect(site.hasEnv).toBe(false);
  });

  test("a spawn named inside a comment or a string is not a site", () => {
    expect(scan(`// Bun.spawnSync(["x"]) in prose\nconst s = "Bun.spawnSync([])";`)).toEqual([]);
    expect(scan(`/** Bun.spawnSync(["x"]) in a doc comment */`)).toEqual([]);
  });

  test("a computed argv head is never exemptible", () => {
    expect(violationOf(scan(`Bun.spawnSync(cmd, { stdout: "pipe" });`)[0])).toContain("COMPUTED");
    expect(violationOf(scan(`Bun.spawnSync([bin, "--version"]);`)[0])).toContain("COMPUTED");
    expect(violationOf(scan(`Bun.spawn([somaBin ?? "soma", "x"]);`)[0])).toContain("COMPUTED");
  });

  test("an allowlisted program with no env is not a violation", () => {
    expect(violationOf(scan(`Bun.spawnSync(["git", "status"], { cwd: repo });`)[0])).toBeNull();
  });

  test("child_process functions are seen, but only where child_process is imported", () => {
    const withImport = scanSource(
      "probe.ts",
      `import { spawnSync } from "node:child_process";\nspawnSync("gh", args, { encoding: "utf-8" });`,
    );
    expect(withImport).toHaveLength(1);
    expect(withImport[0].argvHead).toBe("gh");
    // A local helper called `spawn` in a file with no child_process import is
    // not a process spawn — matching it would make the rule unusable.
    expect(scanSource("probe.ts", `const p = spawn(thing);`)).toEqual([]);
  });

  test("a multi-line call still yields its literal argv head", () => {
    const [site] = scan(`const r = Bun.spawnSync(\n  ["git", "rev-parse", "HEAD"],\n  { cwd: repo },\n);`);
    expect(site.argvHead).toBe("git");
    expect(site.hasEnv).toBe(false);
  });
});
