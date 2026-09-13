/**
 * The class guard for arc#421's leak: **no process is spawned without an
 * explicit `env` that provably carries the caller's environment, unless the
 * program it runs provably cannot reach the operator's home.**
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
 * default: EVERY spawn must say something TRUE about the child's environment,
 * and the only way to say nothing is to run a program on the allowlist below,
 * each entry of which carries its reason.
 *
 * ── Why an allowlist keyed on the PROGRAM ───────────────────────────────────
 *
 * A file/line allowlist rots on the next edit and says nothing about why a
 * site is safe. The real question is what the child does, so the exemption is
 * keyed on what is being run — and a site whose argv head is COMPUTED can
 * never be exempted, because nobody can say what it runs. That is the exact
 * shape of four of the five sites round 4 had to fix.
 *
 * ── Round 5: the VALUE, not the key ─────────────────────────────────────────
 *
 * Round 4's rule asked only whether the token `env` appeared as a property
 * key, which `env: undefined` satisfies while leaking exactly as badly as
 * saying nothing. `runScript` (`src/lib/scripts.ts`) already carries an
 * optional `env` on its own options bag and `install-transaction.ts:573`
 * already threads it through as a possibly-`undefined` shorthand, so
 * `env: opts.env` at the spawn was ONE REFACTOR away from a green guard and a
 * live leak. The rule now classifies what the value is WORTH — see `EnvKind`
 * in the scanner — and only `spawnEnv()`, `process.env`, or an object
 * spreading one of them counts.
 *
 * `env: {}` is REFUSED too, and that is the one judgement call in this file.
 * It does not hand the child the spawn-time environ, so on a narrow reading it
 * "does not leak" — but it hands the child no `HOME` AT ALL, and a child with
 * no `HOME` does not fail: it falls back to the passwd database. Measured on
 * bun 1.3.2, in-process pin `/tmp/PINNED`, spawn-time `HOME` a sandbox:
 *
 * ```
 *   env: {}                 child os.homedir() → /Users/andreas   ← the REAL home
 *   env: { ...process.env } child os.homedir() → /tmp/PINNED
 * ```
 *
 * So `env: {}` is not merely weaker than a pin, it is UNSANDBOXABLE — worse
 * than the bug this guard exists for, because neither an in-process nor a
 * spawn-time pin can reach a `getpwuid` lookup. Refused.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  classifyEnv,
  collectSpawnSites,
  scanSource,
  type SpawnSite,
} from "../helpers/spawn-inventory.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCANNED_DIRS = ["src", "test", "scripts", "bin"] as const;

/**
 * Programs that may be spawned with no `env`, and why each one cannot carry
 * the leak. One line per entry, and the line has to be true.
 */
const LEAK_FREE_PROGRAMS: Readonly<Record<string, string>> = {
  git: "operates on the repo path it is given; touches home only via `config --global|--system`, refused below over the WHOLE parsed argv — and a `git` argv carrying a `...spread` cannot be checked for those flags at all, so it is refused rather than exempted",
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
 * Why an `env` VALUE does not pin the child, or `null` when it does.
 *
 * `absent` returns `null` here because that path may still be exempted by
 * program name below. A STATED but worthless `env` may not: the author made a
 * claim about the child's environment and the claim is false, which is worse
 * than the honest silence the allowlist covers.
 */
function envValueFault(site: SpawnSite): string | null {
  switch (site.envKind) {
    case "pinned":
    case "absent":
      return null;
    case "nullish":
      return `passes \`env: ${site.envText}\`, which bun treats exactly as passing no \`env\` at all — the child gets the SPAWN-TIME environ. Pass \`env: spawnEnv()\`.`;
    case "empty":
      return "passes `env: {}`, so the child has no `HOME` and falls back to the passwd database — it resolves the operator's REAL home, which no pin can reach. Pass `env: spawnEnv()`.";
    case "opaque":
      return `passes \`env: ${site.envText}\`, whose runtime value the source cannot show — if it is \`undefined\` the child silently gets the SPAWN-TIME environ. Pass \`env: spawnEnv()\`, or spread it: \`env: { ...spawnEnv(), … }\`.`;
  }
}

/**
 * The rule, as a function, so the test below and the red-before proofs share
 * one definition. Returns the reason a site is a violation, or `null`.
 */
export function violationOf(site: SpawnSite): string | null {
  const fault = envValueFault(site);
  if (fault !== null) return fault;
  if (site.envKind === "pinned") return null;
  if (site.argvHead === null) {
    return "spawns a COMPUTED command with no explicit `env` — nobody can say what this child does, so it cannot be exempted by name. Pass `env: spawnEnv()`.";
  }
  const reason = LEAK_FREE_PROGRAMS[site.argvHead];
  if (reason === undefined) {
    return `spawns \`${site.argvHead}\` with no explicit \`env\`, and \`${site.argvHead}\` is not on the leak-free allowlist. Pass \`env: spawnEnv()\` (src/lib/user-home.ts), or add \`${site.argvHead}\` to LEAK_FREE_PROGRAMS with a reason that is true.`;
  }
  return null;
}

describe("spawn-env discipline (arc#421 — the class, not the instances)", () => {
  const sites = collectSpawnSites(REPO_ROOT, SCANNED_DIRS);

  test("the inventory actually finds this repository's spawn sites", () => {
    // A scanner that silently matched nothing would make every assertion below
    // vacuously green. The confirmation counted 334 across src/ and test/.
    expect(sites.length).toBeGreaterThan(300);
    expect(sites.some((s) => s.file.startsWith("src/"))).toBe(true);
    expect(sites.some((s) => s.file.startsWith("test/"))).toBe(true);
  });

  test("every spawn site pins the child's env, or runs an allowlisted leak-free program", () => {
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
    // The one way `git` can reach home, and the clause the `git` allowlist
    // entry leans on. Round 4 filtered on `s.text` — the CALLEE'S OWN SOURCE
    // LINE — so a multi-line call, whose `text` is just `Bun.spawnSync(`, was
    // never examined. 88 of this repo's no-`env` sites are multi-line, roughly
    // 30% of them `git`, so the allowlist's stated reason was unchecked for
    // most of the sites it exempted. Match the WHOLE parsed argument text.
    const offenders = sites.filter(
      (s) =>
        s.envKind !== "pinned" &&
        s.argvHead === "git" &&
        GIT_HOME_WRITING_FLAGS.some((f) => s.args.includes(f)),
    );
    expect(offenders.map(describeSite)).toEqual([]);
  });

  test("no allowlisted `git` spawn hides its flags behind a spread", () => {
    // The third shape: `["git", "config", ...flags]` carries no `--global` in
    // its source, so no text match can ever find one. The `git` entry's reason
    // — "refused above" — is simply unprovable for such a site, so it does not
    // get the exemption. Pinning costs nothing (`spawnEnv()` is the inherited
    // environ in production) and converts an unprovable exemption into a
    // sandboxable boundary. Seven wrappers were pinned for this.
    const offenders = sites.filter(
      (s) => s.envKind !== "pinned" && s.argvHead === "git" && s.argvHasSpread,
    );
    expect(offenders.map(describeSite)).toEqual([]);
  });

  test("every allowlist entry carries a reason and is actually used", () => {
    for (const reason of Object.values(LEAK_FREE_PROGRAMS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
    // An unused entry is an exemption nobody has justified against real code.
    const spawned = new Set(sites.filter((s) => s.envKind === "absent").map((s) => s.argvHead));
    const unused = Object.keys(LEAK_FREE_PROGRAMS).filter((p) => !spawned.has(p));
    expect(unused).toEqual([]);
  });

  test("the five sites round 4 fixed pass an env", () => {
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

  test("the seven git wrappers round 5 pinned still pass an env", () => {
    // Same reasoning as above: these are `git(...args)` helpers whose caller
    // supplies arbitrary flags, so the `--global|--system` assertion can never
    // clear them. A revert is a named failure.
    const pinnedWrappers = [
      "src/commands/install.ts",
      "src/lib/composition-upgrade.ts",
      "test/commands/install-repin-396.test.ts",
      "test/commands/install-repin-hardening-396.test.ts",
      "test/commands/provides-files-guard.test.ts",
      "test/unit/composition-hardening.test.ts",
      "test/unit/git-tree.test.ts",
    ];
    for (const file of pinnedWrappers) {
      const spreads = sites.filter((s) => s.file === file && s.argvHead === "git" && s.argvHasSpread);
      expect(spreads.length).toBeGreaterThan(0);
      expect(`${file}: ${spreads.filter((s) => s.envKind !== "pinned").map(describeSite).join(" | ")}`).toBe(
        `${file}: `,
      );
    }
  });
});

describe("the spawn scanner itself", () => {
  const scan = (src: string): SpawnSite[] => scanSource("probe.ts", src);

  test("a bare Bun.spawnSync is a violation", () => {
    const [site] = scan(`Bun.spawnSync(["soma", "project-skill"]);`);
    expect(site.envKind).toBe("absent");
    expect(violationOf(site)).toContain("not on the leak-free allowlist");
  });

  test("only a value that carries the current environ clears it", () => {
    expect(scan(`Bun.spawnSync(["soma"], { env: spawnEnv() });`)[0].envKind).toBe("pinned");
    expect(scan(`Bun.spawn({ cmd: ["soma"], env: spawnEnv() });`)[0].envKind).toBe("pinned");
    expect(scan(`Bun.spawnSync(["soma"], { env: process.env });`)[0].envKind).toBe("pinned");
    expect(scan(`Bun.spawnSync(["soma"], { env: { ...process.env, X: "1" } });`)[0].envKind).toBe("pinned");
    expect(scan(`Bun.spawnSync(["soma"], { env: { ...spawnEnv(), X: "1" } });`)[0].envKind).toBe("pinned");
    expect(scan(`Bun.spawnSync(["soma"], { ...base, env: { ...process.env } });`)[0].envKind).toBe("pinned");
    for (const src of [
      `Bun.spawnSync(["soma"], { env: spawnEnv() });`,
      `Bun.spawnSync(["soma"], { env: { ...process.env } });`,
    ]) {
      expect(violationOf(scan(src)[0])).toBeNull();
    }
  });

  // ── The round-5 BLOCKER, as red cases ────────────────────────────────────
  // Every one of these states an `env` key, so round 4's rule called them all
  // green. Three leak identically to saying nothing; the fourth is worse.

  test("`env: undefined` is refused — it is the leak with a green guard", () => {
    const [site] = scan(`Bun.spawnSync(["soma"], { cwd, env: undefined });`);
    expect(site.hasEnv).toBe(true); // the KEY is there …
    expect(site.envKind).toBe("nullish"); // … and it is worth nothing
    expect(violationOf(site)).toContain("SPAWN-TIME environ");
  });

  test("`env: null` is refused for the same reason", () => {
    const [site] = scan(`Bun.spawnSync(["soma"], { env: null });`);
    expect(site.hasEnv).toBe(true);
    expect(site.envKind).toBe("nullish");
    expect(violationOf(site)).toContain("SPAWN-TIME environ");
  });

  test("a bare identifier — the `env: opts.env` refactor — is refused", () => {
    // The shape the confirmation named: `runScript`'s options bag already
    // carries an optional `env`, so this call compiles, type-checks, passes
    // round 4's rule, and leaks whenever the caller omitted one.
    for (const src of [
      `Bun.spawnSync(["soma"], { env: opts.env });`,
      `Bun.spawnSync(["soma"], { env: someMaybeUndefined });`,
      `Bun.spawnSync(["soma"], { cwd, env });`, // shorthand is a bare identifier too
    ]) {
      const [site] = scan(src);
      expect(site.hasEnv).toBe(true);
      expect(site.envKind).toBe("opaque");
      expect(violationOf(site)).toContain("runtime value the source cannot show");
    }
  });

  test("`env: {}` is refused — no HOME means getpwuid, i.e. the REAL home", () => {
    // The judgement call, stated in the header comment: `{}` does not hand the
    // child the spawn-time environ, but a child with no `HOME` falls back to
    // the passwd database, which NO pin can reach. Measured, not assumed.
    const [site] = scan(`Bun.spawnSync(["soma"], { env: {} });`);
    expect(site.envKind).toBe("empty");
    expect(violationOf(site)).toContain("passwd database");
  });

  test("a stated-but-worthless env is not rescued by the program allowlist", () => {
    // `git` is allowlisted for SILENCE. An author who writes `env: undefined`
    // has made a false claim, which is strictly worse than saying nothing.
    expect(violationOf(scan(`Bun.spawnSync(["git", "status"], { env: undefined });`)[0])).toContain(
      "SPAWN-TIME environ",
    );
  });

  test("classifyEnv is total over the shapes this repo can write", () => {
    expect(classifyEnv(null)).toBe("absent");
    expect(classifyEnv("spawnEnv()")).toBe("pinned");
    expect(classifyEnv("process.env")).toBe("pinned");
    expect(classifyEnv("undefined")).toBe("nullish");
    expect(classifyEnv("null")).toBe("nullish");
    expect(classifyEnv("{}")).toBe("empty");
    expect(classifyEnv("{ PATH: p }")).toBe("opaque");
    expect(classifyEnv("buildEnv()")).toBe("opaque");
    expect(classifyEnv("env")).toBe("opaque");
  });

  test("a substring named env-something does not count", () => {
    const [site] = scan(`Bun.spawnSync(["soma"], { envelope: 1 });`);
    expect(site.envKind).toBe("absent");
    expect(site.envText).toBeNull();
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
    expect(site.envKind).toBe("absent");
  });

  // ── The round-5 MAJOR, as red cases ──────────────────────────────────────
  // The `git` allowlist entry says home is reachable only via
  // `config --global|--system`, refused by a separate assertion. These are the
  // three shapes a `git` call can take; round 4's `s.text` filter saw one.

  test("the three git shapes, and which filter can see each", () => {
    const flagInArgs = (s: SpawnSite): boolean =>
      GIT_HOME_WRITING_FLAGS.some((f) => s.args.includes(f));
    const flagInLine = (s: SpawnSite): boolean =>
      GIT_HOME_WRITING_FLAGS.some((f) => s.text.includes(f));

    // 1 — one line. Both the old and the new filter see it.
    const oneLine = scan(`Bun.spawnSync(["git", "config", "--global", "user.name", "x"]);`)[0];
    expect(flagInLine(oneLine)).toBe(true);
    expect(flagInArgs(oneLine)).toBe(true);

    // 2 — multi-line. `text` is only the callee's line, so the OLD filter was
    // blind; 88 of this repo's no-`env` sites have exactly this shape.
    const multi = scan(
      `Bun.spawnSync(\n  ["git", "config",\n   "--global", "user.name", "x"],\n  { cwd },\n);`,
    )[0];
    expect(multi.text).toBe("Bun.spawnSync(");
    expect(flagInLine(multi)).toBe(false); // ← the MAJOR
    expect(flagInArgs(multi)).toBe(true); // ← fixed
    expect(multi.args).toContain("--global");

    // 3 — spread. The flag is not in the source AT ALL, so no text match can
    // ever find it. Caught by the argv-spread assertion instead.
    const spread = scan(`Bun.spawnSync(["git", "config", ...flags, "user.name"]);`)[0];
    expect(flagInLine(spread)).toBe(false);
    expect(flagInArgs(spread)).toBe(false);
    expect(spread.argvHasSpread).toBe(true); // ← fixed, by a different route
    expect(violationOf(spread)).toBeNull(); // the spread assertion catches it, not violationOf
  });

  test("a spread outside the argv array is not an argv spread", () => {
    // The options bag routinely spreads; only the COMMAND matters here.
    expect(scan(`Bun.spawnSync(["git", "status"], { ...base, cwd });`)[0].argvHasSpread).toBe(false);
    expect(scan(`Bun.spawn({ cmd: ["git", "status"], ...base });`)[0].argvHasSpread).toBe(false);
    expect(scan(`Bun.spawn({ cmd: ["git", ...args] });`)[0].argvHasSpread).toBe(true);
  });

  test("`args` is the whole call, newlines collapsed", () => {
    const [site] = scan(`Bun.spawnSync(\n  ["git", "log"],\n  { cwd: repo },\n);`);
    expect(site.args).toBe(`["git", "log"], { cwd: repo },`);
  });
});
