import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { generateRules } from "../../src/lib/rules.js";
import type { RulesTemplate } from "../../src/types.js";

let root: string;
let packageDir: string;
let consumerDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "arc-rules-test-"));
  packageDir = join(root, "package");
  consumerDir = join(root, "consumer");
  await mkdir(join(packageDir, "templates"), { recursive: true });
  await mkdir(join(consumerDir, "docs", "agents-md"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("generates rule file with placeholder substitution", async () => {
  // Template
  await Bun.write(
    join(packageDir, "templates", "CLAUDE.md.template"),
    "# {REPO_NAME} -- {REPO_DESCRIPTION}\n\n{REPO_DESCRIPTION}\n",
  );

  // Config
  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
repo_description: "PAI Event Relay"
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);

  expect(results).toHaveLength(1);
  expect(results[0].success).toBe(true);

  const output = await readFile(join(consumerDir, "CLAUDE.md"), "utf-8");
  expect(output).toContain("# grove -- PAI Event Relay");
  expect(output).toContain("\nPAI Event Relay\n");
});

test("injects section files at markers", async () => {
  // Template with injection marker
  await Bun.write(
    join(packageDir, "templates", "CLAUDE.md.template"),
    `# {REPO_NAME}

## Architecture

<!-- inject:after:description -->

## Critical Rules

Standard rules here.

<!-- inject:after:critical-rules -->

## Footer
`,
  );

  // Section files
  await Bun.write(
    join(consumerDir, "docs", "agents-md", "architecture.md"),
    "### Custom Architecture\n\nThis repo uses a special pattern.",
  );
  await Bun.write(
    join(consumerDir, "docs", "agents-md", "critical-rules.md"),
    "- Never do X\n- Always do Y",
  );

  // Config
  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
sections:
  - position: "after:description"
    file: docs/agents-md/architecture.md
  - position: "after:critical-rules"
    file: docs/agents-md/critical-rules.md
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);

  const output = await readFile(join(consumerDir, "CLAUDE.md"), "utf-8");
  expect(output).toContain("### Custom Architecture");
  expect(output).toContain("This repo uses a special pattern.");
  expect(output).toContain("- Never do X");
  expect(output).toContain("- Always do Y");
  // Markers should be cleaned up
  expect(output).not.toContain("<!-- inject:");
});

test("skips optional template when format not in generate list", async () => {
  await Bun.write(
    join(packageDir, "templates", ".cursorrules.template"),
    "Cursor rules for {REPO_NAME}",
  );

  // Config without cursorrules in generate list
  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
generate:
  - format: claude-md
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/.cursorrules.template", target: ".cursorrules", config: "agents-md.yaml", optional: true },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);

  // File should NOT have been generated
  const exists = await Bun.file(join(consumerDir, ".cursorrules")).exists();
  expect(exists).toBe(false);
});

test("generates optional template when format is opted in", async () => {
  await Bun.write(
    join(packageDir, "templates", ".cursorrules.template"),
    "Cursor rules for {REPO_NAME}",
  );

  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
generate:
  - format: claude-md
  - format: cursorrules
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/.cursorrules.template", target: ".cursorrules", config: "agents-md.yaml", optional: true },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);

  const output = await readFile(join(consumerDir, ".cursorrules"), "utf-8");
  expect(output).toContain("Cursor rules for grove");
});

test("handles extra_labels placeholder", async () => {
  await Bun.write(
    join(packageDir, "templates", "CLAUDE.md.template"),
    `## Labels

| Label | Purpose |
|-------|---------|
| bug | Bugs |

{PROJECT_SPECIFIC_LABELS}

Done.
`,
  );

  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
extra_labels:
  - name: visibility
  - name: network
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);

  const output = await readFile(join(consumerDir, "CLAUDE.md"), "utf-8");
  expect(output).toContain("| `visibility` |");
  expect(output).toContain("| `network` |");
});

test("errors when required template has no config", async () => {
  await Bun.write(
    join(packageDir, "templates", "CLAUDE.md.template"),
    "# {REPO_NAME}",
  );

  // No config file in consumer dir
  const templates: RulesTemplate[] = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(false);
  expect(results[0].error).toContain("Config file not found");
});

test("silently skips optional template when config is missing", async () => {
  await Bun.write(
    join(packageDir, "templates", "AGENTS.md.template"),
    "# AGENTS",
  );

  const templates: RulesTemplate[] = [
    { source: "templates/AGENTS.md.template", target: "AGENTS.md", config: "agents-md.yaml", optional: true },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);
});

test("multiple sections at same injection point are concatenated", async () => {
  await Bun.write(
    join(packageDir, "templates", "CLAUDE.md.template"),
    `# {REPO_NAME}

<!-- inject:after:description -->

## End
`,
  );

  await Bun.write(
    join(consumerDir, "docs", "agents-md", "section-a.md"),
    "Section A content",
  );
  await Bun.write(
    join(consumerDir, "docs", "agents-md", "section-b.md"),
    "Section B content",
  );

  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
sections:
  - position: "after:description"
    file: docs/agents-md/section-a.md
  - position: "after:description"
    file: docs/agents-md/section-b.md
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);

  const output = await readFile(join(consumerDir, "CLAUDE.md"), "utf-8");
  expect(output).toContain("Section A content");
  expect(output).toContain("Section B content");
  // Both should appear before "## End"
  const aIdx = output.indexOf("Section A");
  const bIdx = output.indexOf("Section B");
  const endIdx = output.indexOf("## End");
  expect(aIdx).toBeLessThan(endIdx);
  expect(bIdx).toBeLessThan(endIdx);
});

test("handles missing section file gracefully", async () => {
  await Bun.write(
    join(packageDir, "templates", "CLAUDE.md.template"),
    `# {REPO_NAME}

<!-- inject:after:description -->

## End
`,
  );

  await Bun.write(
    join(consumerDir, "agents-md.yaml"),
    `template: compass-standards
repo_name: grove
sections:
  - position: "after:description"
    file: docs/agents-md/nonexistent.md
`,
  );

  const templates: RulesTemplate[] = [
    { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
  ];

  const results = await generateRules(packageDir, templates, consumerDir);
  expect(results[0].success).toBe(true);

  const output = await readFile(join(consumerDir, "CLAUDE.md"), "utf-8");
  expect(output).toContain("Warning: section file not found");
});
