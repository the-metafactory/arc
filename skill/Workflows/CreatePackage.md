# CreatePackage Workflow

> Scaffold and build a new arc-installable package from scratch, following all metafactory ecosystem conventions.

## Prerequisites

Before starting:
- [ ] Bun is installed (`bun --version`)
- [ ] Arc is installed (`arc --version`)
- [ ] The package name is unique (check `arc list` and the registry)
- [ ] The package type is decided (skill, tool, agent, prompt, component, pipeline, action)

---

## Steps

### 1. Determine Package Type and Name

**Action:** Ask the user what kind of package they want to build and what it should be called.

**Rules:**
- Name must be lowercase, hyphenated (e.g., `my-cool-tool`, not `MyCoolTool`)
- Name must not conflict with existing packages in the ecosystem
- Type determines file structure and install location (see SKILL.md Section 1)

**Verify:** Name is lowercase-hyphenated and not in `arc list` output.

**Anti-pattern:** Do not default to `skill` type. Ask explicitly. A package that provides a CLI tool should be type `tool`, not type `skill` with a CLI bolted on.

### 2. Scaffold Directory Structure

**Action:** Create the directory structure matching the chosen type.

For a **skill**:
```bash
mkdir -p {name}/skill/Workflows
mkdir -p {name}/src
mkdir -p {name}/tests
mkdir -p {name}/docs/agents-md
```

For a **tool**:
```bash
mkdir -p {name}/src/lib
mkdir -p {name}/tests
mkdir -p {name}/docs/agents-md
```

For an **agent**:
```bash
mkdir -p {name}
```

**Verify:** `ls -R {name}/` shows the expected structure.

### 3. Create arc-manifest.yaml

**Action:** Write `arc-manifest.yaml` at the package root using the arc/v1 schema.

Follow these rules exactly:
- `schema: arc/v1` (required, no exceptions)
- `version: 0.1.0` (always start here for new packages)
- `license: Apache-2.0` (ecosystem default per DD-13, unless there's a specific reason for MIT)
- `namespace`: `the-metafactory` for official packages, user's GitHub username for community
- `capabilities`: Declare explicitly. Start with empty arrays and only add what's genuinely needed.
- `bundle.exclude`: Always include `vendor`, `MEMORY`, `node_modules`, `.git`

**Verify:** Read back the file and confirm all required fields are present. Compare against the schema in SKILL.md Section 1.

**Anti-pattern:** Do not copy capabilities from another package without checking if they apply. Each package's capabilities must reflect its actual needs.

### 4. Create package.json

**Action:** Initialize bun project.

```bash
cd {name}
bun init -y
```

Edit `package.json` to set:
- `name`: matches arc-manifest name
- `scripts.test`: `"bun test"`
- `scripts.typecheck`: `"bunx tsc --noEmit"` (if using TypeScript)

**Verify:** `bun install` succeeds.

### 5. Create SKILL.md (Skill Type Only)

**Action:** Write `skill/SKILL.md` with YAML frontmatter and required sections.

Required in frontmatter:
- `name`: PascalCase skill name
- `description`: Multi-line, includes trigger phrases for activation matching
- `triggers`: Array of activation phrases

Required sections in body:
1. Title and overview (what and why)
2. When to Use / When NOT to Use
3. Workflow Routing Table (maps patterns to `Workflows/*.md` files)

**Verify:** YAML frontmatter parses correctly. All referenced workflow files exist (or are noted as TODO).

**Anti-pattern:** Do not write vague trigger phrases. "use tool" is too broad. "create changelog entry from git log" is specific.

### 6. Create CLI Entry Point (Tool Type Only)

**Action:** Write `src/cli.ts` with Commander.js structure.

```typescript
import { Command } from "commander";

const program = new Command()
  .name("{name}")
  .version("0.1.0")
  .description("{description}");

// Add subcommands here

program.parse();
```

**Verify:** `bun src/cli.ts --version` outputs `0.1.0`.

**Anti-pattern:** Do not use process.argv parsing directly. Use Commander.js for consistency with the ecosystem.

### 7. Create CLAUDE.md via agents-md.yaml

**Action:** Create `agents-md.yaml` at repo root and section files in `docs/agents-md/`.

```yaml
template: compass-standards
generate:
  - format: claude-md
repo_name: {name}
repo_description: "{description}"
deploy_command: "arc upgrade {name}"
version_source: arc-manifest.yaml
sections:
  - position: "after:description"
    file: docs/agents-md/architecture.md
  - position: "after:critical-rules"
    file: docs/agents-md/critical-rules.md
```

Create section files:
- `docs/agents-md/architecture.md`: Describe the package structure
- `docs/agents-md/critical-rules.md`: Add package-specific rules

Then generate: `arc upgrade compass`

**Verify:** CLAUDE.md exists at repo root with ecosystem-standard sections.

### 8. Create Blueprint (If Ecosystem Project)

**Action:** Create `blueprint.yaml` if the package will be registered in `compass/ecosystem/repos.yaml`.

```yaml
schema: blueprint/v1
repo: {short-name}
features:
  - id: {PREFIX}-001
    name: {first-feature}
    status: planned
    iteration: 1
    description: >
      {What the first feature delivers}
```

**Verify:** `blueprint lint` passes (no cycles, no dangling refs).

**Anti-pattern:** Do not create blueprint features that are too coarse. "Build the whole thing" is not a feature. Break into independently deliverable pieces.

### 9. Write Initial Tests

**Action:** Create at least one test file in `tests/`.

```typescript
import { describe, it, expect } from "bun:test";

describe("{name}", () => {
  it("manifest exists and parses", async () => {
    const manifest = await Bun.file("arc-manifest.yaml").text();
    expect(manifest).toContain("schema: arc/v1");
    expect(manifest).toContain(`name: {name}`);
  });
});
```

**Verify:** `bun test` passes.

### 10. Initialize Git and Create First Commit

**Action:** Initialize git, create .gitignore, make first commit.

```bash
git init
echo "node_modules/\n.env\nvendor/\nMEMORY/\n*.tar.gz" > .gitignore
git add .
git commit -m "chore: scaffold {name} package"
```

**Verify:** `git log` shows the initial commit. `git status` is clean.

---

## Verification Checklist

After completing all steps:

- [ ] Directory structure matches the package type
- [ ] `arc-manifest.yaml` exists with all required fields
- [ ] `package.json` exists with correct name and test script
- [ ] `bun install` succeeds
- [ ] `bun test` passes
- [ ] SKILL.md exists with valid frontmatter (skill type only)
- [ ] CLI entry point runs (tool type only)
- [ ] `agents-md.yaml` and section files exist
- [ ] CLAUDE.md is generated
- [ ] Blueprint.yaml exists and lints (if ecosystem project)
- [ ] Git initialized with clean initial commit
- [ ] No secrets or .env files committed
- [ ] No em dashes in any documentation

## What NOT To Do

- Do not skip the arc-manifest.yaml. Every package needs one, even the simplest.
- Do not copy another package's manifest and change the name. Capabilities, dependencies, and structure differ per package.
- Do not use npm, yarn, or pnpm. Bun is the ecosystem standard.
- Do not commit on the main branch after initial scaffold. Use worktrees for all subsequent work.
- Do not assert "tests pass" without running `bun test`. Run it. Read the output.
