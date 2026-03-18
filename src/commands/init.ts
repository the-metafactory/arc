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
 * Scaffold a new skill repo directory.
 */
export async function init(
  targetDir: string,
  name: string,
  author?: string
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

  // Create directory structure
  await mkdir(join(targetDir, "skill", "workflows"), { recursive: true });
  await mkdir(join(targetDir, "src", "lib"), { recursive: true });

  // pai-manifest.yaml
  const manifestContent = `# pai-manifest.yaml — PAI capability declaration
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
    - trigger: "${skillName.replace(/^_/, "").toLowerCase()}"
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

  // package.json
  const packageJson = {
    name: `pai-skill-${skillName.replace(/^_/, "").toLowerCase()}`,
    version: "1.0.0",
    description: `PAI ${skillName} Skill`,
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
  const readmeContent = `# ${skillName}

PAI skill — [brief description].

## Setup

\`\`\`bash
git clone [repo-url] ~/Developer/pai-skill-${skillName.replace(/^_/, "").toLowerCase()}/
cd ~/Developer/pai-skill-${skillName.replace(/^_/, "").toLowerCase()}/
bun install
\`\`\`

## Integration

\`\`\`bash
ln -sfn ~/Developer/pai-skill-${skillName.replace(/^_/, "").toLowerCase()}/skill ~/.claude/skills/${skillName}
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
