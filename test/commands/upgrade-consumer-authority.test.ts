/**
 * arc#423 — a rules/governance upgrade may never write outside an explicitly
 * configured root.
 *
 * On the render side the claim is narrower than "never a half-rendered
 * template", and is stated exactly: a residual `{token}` whose key the config
 * DECLARES is refused (G3), and any residual `{{…}}` token is refused (G4).
 * A residual whose key the config does not declare is classified as prose and
 * is WRITTEN — including the incident's own wrong-key shape. That gap is
 * arc#429, and the fix there is a field (the template declares its own
 * placeholders), not a casing heuristic here.
 *
 * Observed 2026-09-13 on the maintainer's machine: `findConsumerRepos` resolved
 * `BLUEPRINT_DEV_ROOT ?? join(homedir(), "Developer")` through a RAW `homedir()`
 * — unaffected by any in-process `$HOME` pin — and `generateRules` then wrote a
 * generated `CLAUDE.md` into every repo under it that merely HAPPENED to carry a
 * file named `agents-md.yaml`. 138 repos matched; 136 `CLAUDE.md` files were
 * replaced with the bare stub `# {PROJECT_NAME}` (cortex 492 lines -> 3, halden
 * 301 -> 3), because the real repos key their placeholders on `repo_name` and
 * the substitution silently left `{PROJECT_NAME}` unpopulated and wrote it anyway.
 *
 * Four gates:
 *   G1  the scan root is injected, never resolved from a raw `homedir()`, and a
 *       set-but-unusable root is refused BY NAME rather than scanning nothing;
 *   G2  a repo is a consumer only when its config DECLARES the providing package
 *       via `template:` — sitting under a scan root is not authority to rewrite,
 *       and the match is exact against the package's alias set, not a stem;
 *   G3  a placeholder the config ADDRESSES that the render left standing is an
 *       ERROR, not output. Only those: a `{branch}` no config key addresses is
 *       prose, and refusing on it broke every legitimate `arc upgrade compass`.
 *   G4  a residual `{{…}}` token is refused UNCONDITIONALLY. arc substitutes
 *       `{KEY}` only, so a token in the `{{template:…}}`/`{{config:…}}` syntax
 *       is never rendered and never prose — writing it is always a half-
 *       rendered template (arc#426 round 2 / arc#428).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { findConsumerRepos, upgradePackage } from "../../src/commands/upgrade.js";
import { declaresTemplateProvider, generateRules } from "../../src/lib/rules.js";
import { templateAliasSet } from "../../src/lib/template-aliases.js";
import { validateTemplateAliases } from "../../src/lib/validate-manifest.js";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * Build + git-commit a package that declares `provides.templates` targeting
 * CLAUDE.md via an `agents-md.yaml` config — the exact manifest shape behind
 * the incident.
 */
async function createTemplatePackage(
  root: string,
  opts: { name: string; version: string; templateBody: string },
): Promise<{ path: string; url: string }> {
  const repoDir = join(root, `pkg-${opts.name}`);
  await mkdir(join(repoDir, "templates"), { recursive: true });
  await writeFile(join(repoDir, "templates", "CLAUDE.md.template"), opts.templateBody);

  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    YAML.stringify({
      name: opts.name,
      version: opts.version,
      type: "rules",
      tier: "custom",
      author: { name: "tester", github: "tester" },
      provides: {
        templates: [
          { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
        ],
      },
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    }),
  );

  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  return { path: repoDir, url: repoDir };
}

// ---------------------------------------------------------------------------
// G1 — BLUEPRINT_DEV_ROOT unset must NOT fall back to the real `~/Developer`.
// ---------------------------------------------------------------------------

describe("arc#423 G1 — no scan outside an explicitly configured root", () => {
  /**
   * Asserted through the injectable seam rather than by letting a real upgrade
   * run with BLUEPRINT_DEV_ROOT unset. That is deliberate: the ONLY way to
   * observe the old behaviour end-to-end is to let arc walk the real
   * `~/Developer` and start writing — which is the incident, not a test of it.
   * The seam reproduces the exact condition (no configured root, a pinned home
   * carrying a `Developer/` full of matching repos) and proves the resolver
   * never reaches for it.
   */
  test("with BLUEPRINT_DEV_ROOT unset, no directory outside cwd is a candidate", async () => {
    // A "bystander" repo standing in for the 138 real ones: it carries an
    // agents-md.yaml, and it sits under a pinned home's Developer dir —
    // precisely where the raw `homedir()` resolved to, and precisely what an
    // in-process HOME pin was supposed to protect.
    const fakeHome = join(env.root, "fake-home");
    const bystander = join(fakeHome, "Developer", "bystander-repo");
    await mkdir(bystander, { recursive: true });
    await writeFile(
      join(bystander, "agents-md.yaml"),
      YAML.stringify({ template: "SomeOtherPkg", repo_name: "Bystander" }),
    );

    const cwdSandbox = join(env.root, "cwd-sandbox");
    await mkdir(cwdSandbox, { recursive: true });
    await writeFile(
      join(cwdSandbox, "agents-md.yaml"),
      YAML.stringify({ template: "RulesPkg", project_name: "Sandbox" }),
    );

    const templates = [
      { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
    ];

    // The incident's condition: HOME pinned, BLUEPRINT_DEV_ROOT absent.
    const scan = findConsumerRepos(templates, {
      env: { HOME: fakeHome }, // no BLUEPRINT_DEV_ROOT
      cwd: cwdSandbox,
    });

    // cwd only — the pinned home's Developer tree is never reached.
    expect(scan.candidates).toEqual([{ dir: cwdSandbox, origin: "cwd" }]);
    expect(scan.candidates.some((c) => c.dir.startsWith(fakeHome))).toBe(false);
    // UNSET is not a refusal — it is the documented default, so nothing to name.
    expect(scan.rootRefusal).toBeUndefined();

    // And an explicitly configured root DOES fan out — the gate is not an
    // off-switch, it is a demand for explicit authority.
    const configured = findConsumerRepos(templates, {
      env: { BLUEPRINT_DEV_ROOT: join(fakeHome, "Developer") },
      cwd: cwdSandbox,
    });
    expect(configured.candidates).toContainEqual({ dir: bystander, origin: "scan" });
    expect(configured.rootRefusal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// G2 — a repo under the scan root that does NOT declare this package is refused.
// ---------------------------------------------------------------------------

describe("arc#423 G2 — a scan root is not authority; the consumer must declare the package", () => {
  test("a repo whose agents-md.yaml declares a DIFFERENT template package is left byte-identical", async () => {
    const devRoot = join(env.root, "dev-root");
    const foreign = join(devRoot, "foreign-repo");
    await mkdir(foreign, { recursive: true });
    // Declares compass-core — NOT the package being upgraded. This is what
    // every one of the 136 clobbered repos looked like.
    //
    // It supplies `project_name`, and that is the whole point of the case
    // (arc#423 MAJOR 3). With `repo_name` instead, the render leaves
    // `{PROJECT_NAME}` standing and G3 refuses the write — so deleting the G2
    // gate entirely left the suite green and the test proved nothing about G2.
    // Supplying the key makes the render succeed, which means the ONLY thing
    // that can save this file is the authority gate under test.
    await writeFile(
      join(foreign, "agents-md.yaml"),
      YAML.stringify({ template: "compass-core", project_name: "Foreign" }),
    );
    const untouched = "# Foreign\n\nNot this package's to rewrite.\n";
    await writeFile(join(foreign, "CLAUDE.md"), untouched);

    // A genuine consumer that DOES declare the package, proving the gate
    // refuses the foreign repo without breaking the feature.
    const declared = join(devRoot, "declared-repo");
    await mkdir(declared, { recursive: true });
    await writeFile(
      join(declared, "agents-md.yaml"),
      YAML.stringify({ template: "RulesPkg2", project_name: "Declared" }),
    );

    const pkg = await createTemplatePackage(env.root, {
      name: "RulesPkg2",
      version: "1.0.0",
      templateBody: "# {PROJECT_NAME}\n\nGENERATED-ROW\n",
    });
    await install({
      arc: env.arc, host: env.host, db: env.db,
      repoUrl: pkg.url, yes: true, consumerDir: declared,
    });
    await rm(join(declared, "CLAUDE.md"), { force: true });

    const prevDevRoot = process.env.BLUEPRINT_DEV_ROOT;
    const prevCwd = process.cwd();
    process.env.BLUEPRINT_DEV_ROOT = devRoot;
    process.chdir(declared);
    try {
      await upgradePackage(env.db, env.arc, env.host, "RulesPkg2", { force: true });
    } finally {
      process.chdir(prevCwd);
      if (prevDevRoot === undefined) delete process.env.BLUEPRINT_DEV_ROOT;
      else process.env.BLUEPRINT_DEV_ROOT = prevDevRoot;
    }

    // Refused, byte-identical.
    expect(await Bun.file(join(foreign, "CLAUDE.md")).text()).toBe(untouched);
    // The declared consumer still regenerates — the gate is not a blanket off-switch.
    expect(existsSync(join(declared, "CLAUDE.md"))).toBe(true);
    expect(await Bun.file(join(declared, "CLAUDE.md")).text()).toContain("GENERATED-ROW");
  });
});

describe("arc#423 G2 — a stem collision is not a declaration", () => {
  /**
   * The first cut matched `template:` against the package name by stem
   * (`split("-")[0]`), so `compass-evil` was authority for `compass`: a gate
   * answering yes to a package it had never been shown. Matching is now exact
   * against the package's alias set.
   */
  test("compass-evil / compass-core-evil / compassx are refused; the three live spellings are not", async () => {
    const pkgDir = join(env.root, "alias-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    await writeFile(join(pkgDir, "templates", "CLAUDE.md.template"), "# {PROJECT_NAME}\n\nROW\n");
    const templates = [
      { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
    ];

    /** Render into a fresh repo declaring `declared`; true when it was written. */
    async function accepted(declared: string): Promise<boolean> {
      const dir = join(env.root, `alias-${Buffer.from(declared).toString("hex")}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "agents-md.yaml"),
        YAML.stringify({ template: declared, project_name: "Repo" }),
      );
      const results = await generateRules(pkgDir, templates, dir, { packageName: "compass" });
      return results[0]?.success ?? false;
    }

    // Refused — a different package that merely shares a prefix.
    for (const evil of ["compass-evil", "compass-core-evil", "compassx", "compass-"]) {
      expect({ declared: evil, accepted: await accepted(evil) }).toEqual({
        declared: evil,
        accepted: false,
      });
    }

    // Accepted — the three live spellings, plus scope/case variants of them.
    for (const good of [
      "compass",
      "compass-core",
      "compass-standards",
      "@metafactory/compass-core",
      "Compass-Core",
    ]) {
      expect({ declared: good, accepted: await accepted(good) }).toEqual({
        declared: good,
        accepted: true,
      });
    }
  });

  test("a manifest's own templateAliases replace the built-in shim", () => {
    const cfg = (t: string) => ({ template: t }) as unknown as Parameters<
      typeof declaresTemplateProvider
    >[0];
    // Declared aliases are the package's own statement of its names, so they
    // win outright — arc does not union its compatibility list back in.
    expect(declaresTemplateProvider(cfg("compass-new"), "compass", ["compass-new"])).toBe(true);
    expect(declaresTemplateProvider(cfg("compass"), "compass", ["compass-new"])).toBe(true);
    expect(declaresTemplateProvider(cfg("compass-core"), "compass", ["compass-new"])).toBe(false);
    // A package with neither declaration nor shim matches its own name only.
    expect(declaresTemplateProvider(cfg("RulesPkg2"), "RulesPkg2")).toBe(true);
    expect(declaresTemplateProvider(cfg("RulesPkg2-evil"), "RulesPkg2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G3 — an unpopulated substitution is an error, never a written stub; but only
//      for a placeholder the config actually addresses.
// ---------------------------------------------------------------------------

describe("arc#423 G3 — a failed substitution fails loudly instead of writing a stub", () => {
  test("a key the config declares but the render leaves standing is refused, not written", async () => {
    const pkgDir = join(env.root, "stub-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    await writeFile(
      join(pkgDir, "templates", "CLAUDE.md.template"),
      "# {PROJECT_NAME}\n\nBODY\n",
    );

    const consumer = join(env.root, "stub-consumer");
    await mkdir(consumer, { recursive: true });
    // `project_name` IS declared — so the render was asked to fill
    // `{PROJECT_NAME}` — but its value is not a string, so substitution skipped
    // it and the token survived. That is the incident's shape: a real CLAUDE.md
    // about to be truncated to the bare stub `# {PROJECT_NAME}`.
    await writeFile(
      join(consumer, "agents-md.yaml"),
      "template: StubPkg\nproject_name: null\n",
    );
    const untouched = "# Consumer\n\nReal content that must survive.\n";
    await writeFile(join(consumer, "CLAUDE.md"), untouched);

    const results = await generateRules(
      pkgDir,
      [{ source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" }],
      consumer,
      { packageName: "StubPkg" },
    );

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error ?? "").toContain("PROJECT_NAME");
    expect(await Bun.file(join(consumer, "CLAUDE.md")).text()).toBe(untouched);
  });

  test("prose braces no config key addresses are prose, and the render succeeds", async () => {
    // The shape of the only live template there is: compass-core's
    // CLAUDE.md.template carries `{branch}`, `{path}`, `{slug}` and `{type}` as
    // worktree/branch naming EXAMPLES. Refusing on any surviving `{token}` made
    // every legitimate `arc upgrade compass` fail.
    const pkgDir = join(env.root, "prose-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    const body =
      "# {PROJECT_NAME}\n\nWorktrees: `../{repo}-{branch}`\nBranches: `{type}/{slug}`\nPath: `{path}`\n";
    await writeFile(join(pkgDir, "templates", "CLAUDE.md.template"), body);

    const consumer = join(env.root, "prose-consumer");
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, "agents-md.yaml"),
      YAML.stringify({ template: "ProsePkg", project_name: "Prose" }),
    );

    const results = await generateRules(
      pkgDir,
      [{ source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" }],
      consumer,
      { packageName: "ProsePkg" },
    );

    expect(results[0]?.success).toBe(true);
    const written = await Bun.file(join(consumer, "CLAUDE.md")).text();
    // The declared placeholder rendered; the prose survived verbatim.
    expect(written).toContain("# Prose");
    expect(written).toContain("`{type}/{slug}`");
    expect(written).toContain("`{path}`");
  });
});

// ---------------------------------------------------------------------------
// A configured-but-unusable scan root is a NAMED refusal, not a silent no-op.
// ---------------------------------------------------------------------------

describe("arc#423 — an unusable BLUEPRINT_DEV_ROOT is named", () => {
  const templates = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  test.each([
    ["~/Developer", "unexpanded"],
    ["", "empty"],
    ["relative/dev", "relative"],
    ["/nonexistent-scan-root-arc423", "does not exist"],
  ])("BLUEPRINT_DEV_ROOT=%p is refused by name", (value, needle) => {
    const scan = findConsumerRepos(templates, {
      env: { BLUEPRINT_DEV_ROOT: value },
      cwd: "/",
    });
    expect(scan.candidates).toEqual([]);
    expect(scan.rootRefusal ?? "").toContain(needle);
    expect(scan.rootRefusal ?? "").toContain("BLUEPRINT_DEV_ROOT");
  });

  test("a root that is a FILE, not a directory, is refused by name", async () => {
    const file = join(env.root, "not-a-dir");
    await writeFile(file, "");
    const scan = findConsumerRepos(templates, { env: { BLUEPRINT_DEV_ROOT: file }, cwd: "/" });
    expect(scan.candidates).toEqual([]);
    expect(scan.rootRefusal ?? "").toContain("is not a directory");
  });
});

// ---------------------------------------------------------------------------
// An empty agents-md.yaml must not throw out of the render mid-upgrade.
// ---------------------------------------------------------------------------

describe("arc#423 — an empty or non-mapping config is refused, not thrown", () => {
  test.each([
    ["", "empty file"],
    ["# only a comment\n", "comment only"],
    ["- a\n- b\n", "a list"],
    ["just a scalar\n", "a scalar"],
  ])("a config that is %p does not throw", async (content, label) => {
    const pkgDir = join(env.root, `empty-pkg-${Buffer.from(label).toString("hex")}`);
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    await writeFile(join(pkgDir, "templates", "CLAUDE.md.template"), "# {PROJECT_NAME}\n");

    const consumer = join(env.root, `empty-consumer-${Buffer.from(label).toString("hex")}`);
    await mkdir(consumer, { recursive: true });
    await writeFile(join(consumer, "agents-md.yaml"), content);
    const untouched = "# Real\n\nSurvives.\n";
    await writeFile(join(consumer, "CLAUDE.md"), untouched);

    // `config.template` on a `null` parse threw an uncaught TypeError out of
    // generateSingleRule; neither call site wraps it, so ONE empty config under
    // the scan root aborted the whole upgrade mid-swap.
    const results = await generateRules(
      pkgDir,
      [{ source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" }],
      consumer,
      { packageName: "EmptyPkg" },
    );

    expect(results[0]?.success).toBe(false);
    expect(results[0]?.refused).toBe(true);
    expect(results[0]?.error ?? "").toContain("not a YAML mapping");
    expect(await Bun.file(join(consumer, "CLAUDE.md")).text()).toBe(untouched);
  });
});

// ---------------------------------------------------------------------------
// G4 — a residual `{{…}}` token is a STRUCTURAL refusal (arc#426 round 2, F2).
//
// arc's `substitutePlaceholders` emits and matches `{KEY}` only. compass-core's
// real `templates/CLAUDE.md.template` is written in `{{template:…}}` /
// `{{config:…}}`, and `declaredPlaceholders`' `/\{([A-Za-z][A-Za-z0-9_]*)\}/g`
// cannot match a token containing a colon — so the accepted 9139-byte crucible
// render carried 30 unrendered tokens and still returned `success: true`.
//
// There is no prose ambiguity to weigh here, and so no declaration to consult:
// arc CANNOT substitute that syntax, so writing it is ALWAYS a half-rendered
// template. Rendering it is arc#428's business; refusing it is this gate's.
// ---------------------------------------------------------------------------

describe("arc#426 G4 — a residual {{…}} token is refused unconditionally", () => {
  const tmpl = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  /** The confirmation lane's minimal case A11, verbatim. */
  test("A11 — `# {{template:repo_name}}` with `repo_name: crucible` is refused", async () => {
    const pkgDir = join(env.root, "a11-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    await writeFile(join(pkgDir, "templates", "CLAUDE.md.template"), "# {{template:repo_name}}\n");

    const consumer = join(env.root, "a11-consumer");
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, "agents-md.yaml"),
      "template: A11Pkg\nrepo_name: crucible\n",
    );
    const untouched = "# Crucible\n\nReal content that must survive.\n";
    await writeFile(join(consumer, "CLAUDE.md"), untouched);

    const results = await generateRules(pkgDir, tmpl, consumer, { packageName: "A11Pkg" });

    expect(results[0]?.success).toBe(false);
    // Named by token AND by file — a refusal you can act on.
    expect(results[0]?.error ?? "").toContain("{{template:repo_name}}");
    expect(results[0]?.error ?? "").toContain(join(consumer, "CLAUDE.md"));
    expect(await Bun.file(join(consumer, "CLAUDE.md")).text()).toBe(untouched);
  });

  test("the real compass-core template shape is refused, not written", async () => {
    const pkgDir = join(env.root, "cc-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    // The live shape: repeated `{{template:sops_path}}`, `{{template:repo_name}}`
    // and `{{config:org.name}}` alongside single-brace PROSE that must stay prose.
    await writeFile(
      join(pkgDir, "templates", "CLAUDE.md.template"),
      [
        "# {{template:repo_name}} -- {{config:org.name}}",
        "",
        "Read `{{template:sops_path}}/dev-pipeline.md` first.",
        "Then `{{template:sops_path}}/pr-review.md`.",
        "",
        "Worktrees: `../{repo}-{branch}`; branches `{type}/{slug}`.",
        "",
        "Regenerated for {{template:repo_name}}.",
        "",
      ].join("\n"),
    );

    const consumer = join(env.root, "cc-consumer");
    await mkdir(consumer, { recursive: true });
    // crucible's own unmodified key shape.
    await writeFile(
      join(consumer, "agents-md.yaml"),
      YAML.stringify({ template: "compass-core", repo_name: "crucible" }),
    );
    const untouched = "# crucible -- The infrastructure factory\n\n492 lines of real content.\n";
    await writeFile(join(consumer, "CLAUDE.md"), untouched);

    const results = await generateRules(pkgDir, tmpl, consumer, {
      packageName: "compass",
      packageAliases: ["compass", "compass-core"],
    });

    expect(results[0]?.success).toBe(false);
    const err = results[0]?.error ?? "";
    // Every distinct token named, deduplicated, once.
    expect(err).toContain("{{template:repo_name}}");
    expect(err).toContain("{{template:sops_path}}");
    expect(err).toContain("{{config:org.name}}");
    expect(err).toContain("3 token(s)");
    // Prose single braces are NOT dragged into this refusal.
    expect(err).not.toContain("{slug}");
    expect(await Bun.file(join(consumer, "CLAUDE.md")).text()).toBe(untouched);
  });

  test("the refusal does not depend on what the config declares", async () => {
    // Same token, an EMPTY config beyond the declaration: still refused. The
    // gate is structural, so `declaredPlaceholders` never enters into it.
    const pkgDir = join(env.root, "g4-nodecl-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    await writeFile(join(pkgDir, "templates", "CLAUDE.md.template"), "# {{config:anything}}\n");

    const consumer = join(env.root, "g4-nodecl-consumer");
    await mkdir(consumer, { recursive: true });
    await writeFile(join(consumer, "agents-md.yaml"), "template: G4Pkg\n");
    await writeFile(join(consumer, "CLAUDE.md"), "# Real\n");

    const results = await generateRules(pkgDir, tmpl, consumer, { packageName: "G4Pkg" });
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error ?? "").toContain("{{config:anything}}");
    expect(await Bun.file(join(consumer, "CLAUDE.md")).text()).toBe("# Real\n");
  });
});

// ---------------------------------------------------------------------------
// `provides.templateAliases` is validated where every other manifest field is
// (arc#426 round 2, F3 promoted). Two live consequences, both reproduced:
//   `[123]`   -> `TypeError: name.trim is not a function`, aborting the upgrade
//   a SCALAR  -> spreads to single-character aliases, so `template: o` becomes
//                authority and the real alias is silently dropped, stopping
//                regeneration for every live consumer.
// Same defect class this PR fixed one level up for `agents-md.yaml`.
// ---------------------------------------------------------------------------

describe("arc#426 — provides.templateAliases is validated, not trusted", () => {
  test("absent or a list of non-empty strings is accepted", () => {
    expect(validateTemplateAliases(undefined)).toEqual([]);
    expect(validateTemplateAliases({})).toEqual([]);
    expect(validateTemplateAliases({ templateAliases: ["compass", "compass-core"] })).toEqual([]);
  });

  test.each([
    [[123], "provides.templateAliases[0]"],
    [[null], "provides.templateAliases[0]"],
    [["compass", ""], "provides.templateAliases[1]"],
    [["compass", "   "], "provides.templateAliases[1]"],
    [["compass", { a: 1 }], "provides.templateAliases[1]"],
  ])("%p is refused by name", (aliases, field) => {
    const v = validateTemplateAliases({ templateAliases: aliases });
    expect(v.map((x) => x.field)).toContain(field);
    expect(v[0]?.rule ?? "").toContain("non-empty string");
  });

  test.each([
    ["compass-core", "a scalar"],
    [{ compass: true }, "a mapping"],
    [42, "a number"],
  ])("a non-list (%p, %s) is refused by name", (aliases) => {
    const v = validateTemplateAliases({ templateAliases: aliases });
    expect(v.map((x) => x.field)).toEqual(["provides.templateAliases"]);
    expect(v[0]?.rule ?? "").toContain("must be a list of non-empty strings");
  });

  test("`[123]` no longer throws out of the regeneration — it is a named refusal", () => {
    // Before: `templateAliasSet` called `canonicalMemberKey(123)`, which threw
    // `TypeError: name.trim is not a function` and aborted the upgrade.
    expect(() =>
      templateAliasSet("compass", [123] as unknown as readonly string[]),
    ).not.toThrow();
    // And the bad entry contributes nothing — `123` never becomes authority.
    // An unusable declaration degrades to NO declaration, so the shim applies
    // and live consumers keep regenerating.
    const set = templateAliasSet("compass", [123] as unknown as readonly string[]);
    expect([...set]).toEqual(["compass", "compass-core", "compass-standards"]);
    expect(set.has("123")).toBe(false);
  });

  test("a YAML scalar no longer spreads into single-character aliases", () => {
    // Before: `[...("compass-core")]` produced `c`,`o`,`m`,… so `template: o`
    // was authority and `compass-core` — the real alias — was dropped.
    const set = templateAliasSet("compass", "compass-core" as unknown as readonly string[]);
    expect(set.has("o")).toBe(false);
    expect(set.has("c")).toBe(false);
    // Falls back to the built-in shim, so live consumers keep regenerating.
    expect(set.has("compass-core")).toBe(true);
  });
});
