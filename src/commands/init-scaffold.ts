export type ArtifactInitType = "skill" | "tool" | "agent" | "prompt" | "pipeline";

/**
 * A single file `init()` will create. The list returned by
 * {@link scaffoldEntriesFor} is the SOLE source of truth for what
 * `init()` writes — pre-flight overwrite check, mkdir-of-parents, and
 * the actual write loop all iterate the same array. Previously a
 * paths-only array sat parallel to inline `Bun.write` calls, requiring
 * a drift-guard test to catch skew. Sage P148 cycles 4 / 5 / 6 flagged
 * the parallel sources repeatedly; cycle 7's refactor consolidated
 * them into this shape.
 */
export interface ScaffoldEntry {
  /** Path relative to the scaffold's target directory. */
  path: string;
  /** File contents to write verbatim. */
  content: string;
}

/**
 * Enumerate every file `init()` will create for a given artifact type,
 * with contents. Single source of truth — pre-flight check + writes
 * both iterate this array.
 */
export function scaffoldEntriesFor(
  type: ArtifactInitType,
  name: string,
  author?: string,
): ScaffoldEntry[] {
  const lowerName = name.replace(/^_/, "").toLowerCase();
  const authorName = author ?? "username";
  const prefix = `arc-${type}`;

  const entries: ScaffoldEntry[] = [
    { path: "arc-manifest.yaml", content: buildManifest(type, name, lowerName, authorName) },
    { path: "package.json", content: buildPackageJson(type, name, lowerName, prefix) },
    { path: "README.md", content: buildReadme(type, name, lowerName, prefix) },
    { path: ".gitignore", content: GITIGNORE },
  ];

  switch (type) {
    case "tool":
      entries.push({ path: `${lowerName}.ts`, content: buildToolEntry(name) });
      break;
    case "skill":
      entries.push(
        { path: "skill/SKILL.md", content: buildSkillMd(name) },
        { path: "skill/workflows/Main.md", content: SKILL_WORKFLOW_MAIN },
      );
      break;
    case "agent":
      entries.push({ path: `agent/${lowerName}.md`, content: buildAgentMd(name) });
      break;
    case "prompt":
      entries.push({ path: `prompt/${lowerName}.md`, content: buildPromptMd(name) });
      break;
    case "pipeline":
      entries.push(
        { path: "pipeline.yaml", content: buildPipelineYaml(name) },
        { path: "A_EXAMPLE/action.json", content: PIPELINE_ACTION_JSON },
        { path: "A_EXAMPLE/action.ts", content: PIPELINE_ACTION_TS },
      );
      break;
  }

  return entries;
}

// ── Content builders ────────────────────────────────────────────────────
//
// Pure functions; no side effects. Each returns the file body verbatim.

function buildManifest(
  type: ArtifactInitType,
  name: string,
  lowerName: string,
  authorName: string,
): string {
  const header = `# arc-manifest.yaml — capability declaration
schema: arc/v1
name: ${name}
version: 1.0.0
type: ${type}
tier: custom

author:
  name: ${authorName}
  github: ${authorName}

`;
  switch (type) {
    case "tool":
      return header + `provides:
  cli:
    - command: "bun ${lowerName}.ts"
      name: "${lowerName}"
  # hooks:
  #   - event: PostToolUse
  #     command: "\${PAI_DIR}/hooks/MyHook.hook.ts"

depends_on:
  tools:
    - name: bun
      version: ">=1.0.0"

capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: false
  secrets: []
`;
    case "skill":
      return header + `provides:
  skill:
    - trigger: "${lowerName}"
  # cli:
  #   - command: "bun src/tool.ts"
  # hooks:
  #   - event: PostToolUse
  #     command: "\${PAI_DIR}/hooks/MyHook.hook.ts"

depends_on:
  tools:
    - name: bun
      version: ">=1.0.0"

capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: false
  secrets: []
`;
    case "agent":
      return header + `capabilities:
  filesystem:
    read:
      - agent/
  network: []
  bash:
    allowed: false
  secrets: []
`;
    case "pipeline":
      return header + `capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: true
    restricted_to:
      - bun
  secrets: []
`;
    case "prompt":
      return header + `capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: false
  secrets: []
`;
  }
}

function buildPackageJson(
  type: ArtifactInitType,
  name: string,
  lowerName: string,
  prefix: string,
): string {
  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  return JSON.stringify(
    {
      name: `${prefix}-${lowerName}`,
      version: "1.0.0",
      description: `arc ${name} ${typeLabel}`,
      type: "module",
      scripts: { test: "bun test" },
      dependencies: {},
    },
    null,
    2,
  ) + "\n";
}

function buildReadme(
  type: ArtifactInitType,
  name: string,
  lowerName: string,
  prefix: string,
): string {
  const pkg = `${prefix}-${lowerName}`;
  switch (type) {
    case "tool":
      return `# ${name}

arc tool — [brief description].

## Setup

\`\`\`bash
arc install ${pkg}
\`\`\`

## Manual Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${pkg}/
cd ~/Developer/${pkg}/
bun install
\`\`\`

## License

MIT
`;
    case "skill":
      return `# ${name}

arc skill — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${pkg}/
cd ~/Developer/${pkg}/
bun install
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${pkg}/skill ~/.claude/skills/${name}
\`\`\`

## License

MIT
`;
    case "agent":
      return `# ${name}

arc agent — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${pkg}/
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${pkg}/agent ~/.claude/agents/${name}
\`\`\`

## License

MIT
`;
    case "pipeline":
      return `# ${name}

arc pipeline — [brief description].

## Setup

\`\`\`bash
arc install ${pkg}
\`\`\`

## Manual Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${pkg}/
cd ~/Developer/${pkg}/
bun install
\`\`\`

## License

MIT
`;
    case "prompt":
      return `# ${name}

arc prompt — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${pkg}/
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${pkg}/prompt ~/.claude/prompts/${name}
\`\`\`

## License

MIT
`;
  }
}

function buildToolEntry(name: string): string {
  return `#!/usr/bin/env bun

/**
 * ${name} — arc tool
 */

console.log("${name} tool");
`;
}

function buildSkillMd(name: string): string {
  return `---
name: ${name}
description: |
  [Describe what this skill does]

  USE WHEN user says "[trigger phrase]"
---

# ${name}

[Instructions for the AI agent]

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| [trigger] | \`Workflows/Main.md\` |
`;
}

function buildAgentMd(name: string): string {
  return `---
name: ${name}
description: "[Describe what this agent does]"
model: sonnet

persona:
  name: "${name}"
  title: "[Agent title or role]"
  background: |
    [Describe the agent's background, expertise, and personality]
---

# ${name}

[Detailed instructions for how this agent should behave]

## Capabilities

- [Capability 1]
- [Capability 2]

## Constraints

- [Constraint 1]
- [Constraint 2]
`;
}

function buildPromptMd(name: string): string {
  return `---
name: ${name}
description: "[Describe what this prompt does]"
version: 1.0.0
---

# ${name}

## System

[System-level instructions or context for the model]

## User Template

[The prompt template. Use {{variable}} for placeholders.]

## Variables

| Variable | Description | Required |
|----------|-------------|----------|
| {{variable}} | [Description] | yes |

## Example

**Input:**
\`\`\`
[Example input]
\`\`\`

**Output:**
\`\`\`
[Expected output]
\`\`\`
`;
}

function buildPipelineYaml(name: string): string {
  return `name: ${name}
description: "[Describe what this pipeline does]"
version: 1.0.0

actions:
  - name: A_EXAMPLE
    description: "Example action"
`;
}

const SKILL_WORKFLOW_MAIN = `# Main Workflow

## Steps

1. [Step 1]
2. [Step 2]
`;

const PIPELINE_ACTION_JSON = JSON.stringify(
  {
    name: "A_EXAMPLE",
    description: "Example action — replace with your logic",
    inputs: { data: { type: "string", description: "Input data" } },
    outputs: { result: { type: "string", description: "Output result" } },
  },
  null,
  2,
) + "\n";

const PIPELINE_ACTION_TS = `#!/usr/bin/env bun

/**
 * A_EXAMPLE — example pipeline action
 */

const input = JSON.parse(process.argv[2] ?? "{}");
console.log(JSON.stringify({ result: \`Processed: \${input.data}\` }));
`;

const GITIGNORE = `node_modules/
.env
*.env
secrets/
cache/
`;
