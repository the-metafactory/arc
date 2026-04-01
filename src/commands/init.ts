import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

export type ArtifactInitType = "skill" | "tool" | "agent" | "prompt" | "pipeline";

export interface InitResult {
  success: boolean;
  path?: string;
  error?: string;
  files?: string[];
}

/**
 * Scaffold a new skill, tool, agent, or prompt repo directory.
 */
export async function init(
  targetDir: string,
  name: string,
  author?: string,
  type: ArtifactInitType = "skill"
): Promise<InitResult> {
  if (existsSync(targetDir)) {
    return {
      success: false,
      error: `Directory already exists: ${targetDir}`,
    };
  }

  const authorName = author ?? "username";
  const files: string[] = [];
  const prefix = `arc-${type}`;
  const lowerName = name.replace(/^_/, "").toLowerCase();

  // ── Directory structure ──────────────────────────────────────────────────

  if (type === "tool") {
    await mkdir(join(targetDir, "lib"), { recursive: true });
  } else if (type === "skill") {
    await mkdir(join(targetDir, "skill", "workflows"), { recursive: true });
  } else if (type === "agent") {
    await mkdir(join(targetDir, "agent"), { recursive: true });
  } else if (type === "prompt") {
    await mkdir(join(targetDir, "prompt"), { recursive: true });
  }

  // ── arc-manifest.yaml ───────────────────────────────────────────────────

  let manifestContent: string;

  if (type === "tool") {
    manifestContent = `# arc-manifest.yaml — capability declaration
schema: arc/v1
name: ${name}
version: 1.0.0
type: tool
tier: custom

author:
  name: ${authorName}
  github: ${authorName}

provides:
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
  } else if (type === "skill") {
    manifestContent = `# arc-manifest.yaml — capability declaration
schema: arc/v1
name: ${name}
version: 1.0.0
type: skill
tier: custom

author:
  name: ${authorName}
  github: ${authorName}

provides:
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
  } else if (type === "agent") {
    manifestContent = `# arc-manifest.yaml — capability declaration
schema: arc/v1
name: ${name}
version: 1.0.0
type: agent
tier: custom

author:
  name: ${authorName}
  github: ${authorName}

capabilities:
  filesystem:
    read:
      - agent/
  network: []
  bash:
    allowed: false
  secrets: []
`;
  } else if (type === "pipeline") {
    manifestContent = `# arc-manifest.yaml — capability declaration
schema: arc/v1
name: ${name}
version: 1.0.0
type: pipeline
tier: custom

author:
  name: ${authorName}
  github: ${authorName}

capabilities:
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
  } else {
    // prompt
    manifestContent = `# arc-manifest.yaml — capability declaration
schema: arc/v1
name: ${name}
version: 1.0.0
type: prompt
tier: custom

author:
  name: ${authorName}
  github: ${authorName}

capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: false
  secrets: []
`;
  }

  await Bun.write(join(targetDir, "arc-manifest.yaml"), manifestContent);
  files.push("arc-manifest.yaml");

  // ── Type-specific files ─────────────────────────────────────────────────

  if (type === "tool") {
    const toolContent = `#!/usr/bin/env bun

/**
 * ${name} — arc tool
 */

console.log("${name} tool");
`;
    await Bun.write(join(targetDir, `${lowerName}.ts`), toolContent);
    files.push(`${lowerName}.ts`);
  } else if (type === "skill") {
    const skillMdContent = `---
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
    await Bun.write(join(targetDir, "skill", "SKILL.md"), skillMdContent);
    files.push("skill/SKILL.md");

    const workflowContent = `# Main Workflow

## Steps

1. [Step 1]
2. [Step 2]
`;
    await Bun.write(
      join(targetDir, "skill", "workflows", "Main.md"),
      workflowContent
    );
    files.push("skill/workflows/Main.md");
  } else if (type === "agent") {
    const agentMdContent = `---
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
    await Bun.write(join(targetDir, "agent", `${lowerName}.md`), agentMdContent);
    files.push(`agent/${lowerName}.md`);
  } else if (type === "prompt") {
    const promptMdContent = `---
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
    await Bun.write(join(targetDir, "prompt", `${lowerName}.md`), promptMdContent);
    files.push(`prompt/${lowerName}.md`);
  } else if (type === "pipeline") {
    const pipelineYaml = `name: ${name}
description: "[Describe what this pipeline does]"
version: 1.0.0

actions:
  - name: A_EXAMPLE
    description: "Example action"
`;
    await Bun.write(join(targetDir, "pipeline.yaml"), pipelineYaml);
    files.push("pipeline.yaml");

    const actionJson = JSON.stringify({
      name: "A_EXAMPLE",
      description: "Example action — replace with your logic",
      inputs: { data: { type: "string", description: "Input data" } },
      outputs: { result: { type: "string", description: "Output result" } },
    }, null, 2) + "\n";
    await Bun.write(join(targetDir, "A_EXAMPLE", "action.json"), actionJson);
    files.push("A_EXAMPLE/action.json");

    const actionTs = `#!/usr/bin/env bun

/**
 * A_EXAMPLE — example pipeline action
 */

const input = JSON.parse(process.argv[2] ?? "{}");
console.log(JSON.stringify({ result: \`Processed: \${input.data}\` }));
`;
    await Bun.write(join(targetDir, "A_EXAMPLE", "action.ts"), actionTs);
    files.push("A_EXAMPLE/action.ts");
  }

  // ── package.json ────────────────────────────────────────────────────────

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const packageJson = {
    name: `${prefix}-${lowerName}`,
    version: "1.0.0",
    description: `arc ${name} ${typeLabel}`,
    type: "module",
    scripts: {
      test: "bun test",
    },
    dependencies: {},
  };

  await Bun.write(
    join(targetDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n"
  );
  files.push("package.json");

  // ── README.md ───────────────────────────────────────────────────────────

  let readmeContent: string;

  if (type === "tool") {
    readmeContent = `# ${name}

arc tool — [brief description].

## Setup

\`\`\`bash
arc install ${prefix}-${lowerName}
\`\`\`

## Manual Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${prefix}-${lowerName}/
cd ~/Developer/${prefix}-${lowerName}/
bun install
\`\`\`

## License

MIT
`;
  } else if (type === "skill") {
    readmeContent = `# ${name}

arc skill — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${prefix}-${lowerName}/
cd ~/Developer/${prefix}-${lowerName}/
bun install
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${prefix}-${lowerName}/skill ~/.claude/skills/${name}
\`\`\`

## License

MIT
`;
  } else if (type === "agent") {
    readmeContent = `# ${name}

arc agent — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${prefix}-${lowerName}/
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${prefix}-${lowerName}/agent ~/.claude/agents/${name}
\`\`\`

## License

MIT
`;
  } else if (type === "pipeline") {
    readmeContent = `# ${name}

arc pipeline — [brief description].

## Setup

\`\`\`bash
arc install ${prefix}-${lowerName}
\`\`\`

## Manual Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${prefix}-${lowerName}/
cd ~/Developer/${prefix}-${lowerName}/
bun install
\`\`\`

## License

MIT
`;
  } else {
    // prompt
    readmeContent = `# ${name}

arc prompt — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${prefix}-${lowerName}/
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${prefix}-${lowerName}/prompt ~/.claude/prompts/${name}
\`\`\`

## License

MIT
`;
  }

  await Bun.write(join(targetDir, "README.md"), readmeContent);
  files.push("README.md");

  // ── .gitignore ──────────────────────────────────────────────────────────

  const gitignoreContent = `node_modules/
.env
*.env
secrets/
cache/
`;

  await Bun.write(join(targetDir, ".gitignore"), gitignoreContent);
  files.push(".gitignore");

  return {
    success: true,
    path: targetDir,
    files,
  };
}
