import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

export type ArtifactInitType = "skill" | "tool" | "agent" | "prompt";

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
  const prefix = `pai-${type}`;
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

  // ── pai-manifest.yaml ───────────────────────────────────────────────────

  let manifestContent: string;

  if (type === "tool") {
    manifestContent = `# pai-manifest.yaml — PAI capability declaration
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
    manifestContent = `# pai-manifest.yaml — PAI capability declaration
# Schema: pai-pkg DESIGN.md §2 (pai-manifest.yaml)

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
    manifestContent = `# pai-manifest.yaml — PAI capability declaration
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
  } else {
    // prompt
    manifestContent = `# pai-manifest.yaml — PAI capability declaration
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

  await Bun.write(join(targetDir, "pai-manifest.yaml"), manifestContent);
  files.push("pai-manifest.yaml");

  // ── Type-specific files ─────────────────────────────────────────────────

  if (type === "tool") {
    const toolContent = `#!/usr/bin/env bun

/**
 * ${name} — PAI tool
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
  }

  // ── package.json ────────────────────────────────────────────────────────

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  const packageJson = {
    name: `${prefix}-${lowerName}`,
    version: "1.0.0",
    description: `PAI ${name} ${typeLabel}`,
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

PAI tool — [brief description].

## Setup

\`\`\`bash
pai-pkg install ${prefix}-${lowerName}
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

PAI skill — [brief description].

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

PAI agent — [brief description].

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
  } else {
    // prompt
    readmeContent = `# ${name}

PAI prompt — [brief description].

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
