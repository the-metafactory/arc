/**
 * arc#423 — a rules/governance upgrade may never write outside an explicitly
 * configured root, and may never write a half-rendered template.
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
 * Three gates, one per test below:
 *   G1  the scan root is injected, never resolved from a raw `homedir()`;
 *   G2  a repo is a consumer only when its config DECLARES the providing package
 *       via `template:` — sitting under a scan root is not authority to rewrite;
 *   G3  an unsubstituted `{PLACEHOLDER}` left in the render is an ERROR, not output.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { findConsumerRepos, upgradePackage } from "../../src/commands/upgrade.js";
import { generateRules } from "../../src/lib/rules.js";
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
    const candidates = findConsumerRepos(templates, {
      env: { HOME: fakeHome }, // no BLUEPRINT_DEV_ROOT
      cwd: cwdSandbox,
    });

    // cwd only — the pinned home's Developer tree is never reached.
    expect(candidates).toEqual([{ dir: cwdSandbox, origin: "cwd" }]);
    expect(candidates.some((c) => c.dir.startsWith(fakeHome))).toBe(false);

    // And an explicitly configured root DOES fan out — the gate is not an
    // off-switch, it is a demand for explicit authority.
    const configured = findConsumerRepos(templates, {
      env: { BLUEPRINT_DEV_ROOT: join(fakeHome, "Developer") },
      cwd: cwdSandbox,
    });
    expect(configured).toContainEqual({ dir: bystander, origin: "scan" });
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
    await writeFile(
      join(foreign, "agents-md.yaml"),
      YAML.stringify({ template: "compass-core", repo_name: "Foreign" }),
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

// ---------------------------------------------------------------------------
// G3 — an unpopulated substitution is an error, never a written stub.
// ---------------------------------------------------------------------------

describe("arc#423 G3 — a failed substitution fails loudly instead of writing a stub", () => {
  test("a template whose placeholder the config does not supply is refused, not written", async () => {
    const pkgDir = join(env.root, "stub-pkg");
    await mkdir(join(pkgDir, "templates"), { recursive: true });
    // `{PROJECT_NAME}` — the placeholder the real repos never supply.
    await writeFile(
      join(pkgDir, "templates", "CLAUDE.md.template"),
      "# {PROJECT_NAME}\n\nBODY\n",
    );

    const consumer = join(env.root, "stub-consumer");
    await mkdir(consumer, { recursive: true });
    await writeFile(
      join(consumer, "agents-md.yaml"),
      // Declares the package, but supplies `repo_name`, not `project_name` —
      // exactly the real-world config shape that produced `# {PROJECT_NAME}`.
      YAML.stringify({ template: "StubPkg", repo_name: "Consumer" }),
    );
    const untouched = "# Consumer\n\nReal content that must survive.\n";
    await writeFile(join(consumer, "CLAUDE.md"), untouched);

    const results = await generateRules(
      pkgDir,
      [{ source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" }],
      consumer,
      { packageName: "StubPkg" },
    );

    // Loud failure, naming the placeholder.
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error ?? "").toContain("PROJECT_NAME");
    // And nothing was written.
    expect(await Bun.file(join(consumer, "CLAUDE.md")).text()).toBe(untouched);
  });
});
