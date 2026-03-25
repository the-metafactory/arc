import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

export interface InitResult {
  success: boolean;
  path?: string;
  error?: string;
  files?: string[];
}

/**
 * Scaffold a new skill or tool repo directory.
 */
export async function init(
  targetDir: string,
  name: string,
  author?: string,
  isTool?: boolean
): Promise<InitResult> {
  if (existsSync(targetDir)) {
    return {
      success: false,
      error: `Directory already exists: ${targetDir}`,
    };
  }

  const authorName = author ?? "username";
  const skillName = name.startsWith("_") ? name : name;
  const files: string[] = [];
  const prefix = isTool ? "pai-tool" : "pai-skill";
  const lowerName = skillName.replace(/^_/, "").toLowerCase();

  if (isTool) {
    // Tool structure: flat, no skill/ subdirectory
    await mkdir(join(targetDir, "lib"), { recursive: true });
  } else {
    // Skill structure: skill/ subdirectory with workflows
    await mkdir(join(targetDir, "skill", "workflows"), { recursive: true });
    await mkdir(join(targetDir, "src", "lib"), { recursive: true });
  }

  // pai-manifest.yaml
  const manifestContent = isTool
    ? `# pai-manifest.yaml — PAI capability declaration
name: ${skillName}
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
`
    : `# pai-manifest.yaml — PAI capability declaration
# Schema: pai-pkg DESIGN.md §2 (pai-manifest.yaml)

name: ${skillName}
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

  await Bun.write(join(targetDir, "pai-manifest.yaml"), manifestContent);
  files.push("pai-manifest.yaml");

  if (isTool) {
    // Tool entry point
    const toolContent = `#!/usr/bin/env bun

/**
 * ${skillName} — PAI tool
 */

console.log("${skillName} tool");
`;
    await Bun.write(join(targetDir, `${lowerName}.ts`), toolContent);
    files.push(`${lowerName}.ts`);
  } else {
    // SKILL.md
    const skillMdContent = `---
name: ${skillName}
description: |
  [Describe what this skill does]

  USE WHEN user says "[trigger phrase]"
---

# ${skillName}

[Instructions for the AI agent]

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| [trigger] | \`Workflows/Main.md\` |
`;

    await Bun.write(join(targetDir, "skill", "SKILL.md"), skillMdContent);
    files.push("skill/SKILL.md");

    // Workflow template
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
  }

  // package.json
  const packageJson = {
    name: `${prefix}-${lowerName}`,
    version: "1.0.0",
    description: `PAI ${skillName} ${isTool ? "Tool" : "Skill"}`,
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

  // README.md
  const readmeContent = isTool
    ? `# ${skillName}

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
`
    : `# ${skillName}

PAI skill — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/${prefix}-${lowerName}/
cd ~/Developer/${prefix}-${lowerName}/
bun install
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/${prefix}-${lowerName}/skill ~/.claude/skills/${skillName}
\`\`\`

## License

MIT
`;

  await Bun.write(join(targetDir, "README.md"), readmeContent);
  files.push("README.md");

  // .gitignore
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
