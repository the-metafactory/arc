import { basename, join } from "path";
import { existsSync, lstatSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { platform } from "os";

export type ArtifactInitType = "skill" | "tool" | "agent" | "prompt" | "pipeline";

/**
 * Enumerate the relative paths a scaffold will write for a given type.
 * Sage P148 cycle 3 security: in-place mode silently overwrote
 * pre-existing README.md / package.json / SKILL.md / .gitignore via
 * `Bun.write`. arc#107 documents in-place as "layer cleanly", which is
 * a lie unless every target is checked before write. This list keeps
 * the pre-flight check in lockstep with the writes below.
 */
function scaffoldFilesFor(type: ArtifactInitType, lowerName: string): string[] {
  const common = ["arc-manifest.yaml", "package.json", "README.md", ".gitignore"];
  switch (type) {
    case "tool":
      return [...common, `${lowerName}.ts`];
    case "skill":
      return [...common, "skill/SKILL.md", "skill/workflows/Main.md"];
    case "agent":
      return [...common, `agent/${lowerName}.md`];
    case "prompt":
      return [...common, `prompt/${lowerName}.md`];
    case "pipeline":
      return [...common, "pipeline.yaml", "A_EXAMPLE/action.json", "A_EXAMPLE/action.ts"];
  }
}

/**
 * Resolve `arc init`'s `[name]` arg + cwd into a `{name, targetDir}` tuple
 * — pure function so it can be unit-tested without spawning the CLI.
 *
 * arc#107 semantics:
 *   - argless OR `.` OR `<name>` matching basename(cwd) → scaffold in cwd
 *   - `<name>` different from basename(cwd) → ./<name>/ (no `arc-<type>-` prefix)
 *   - explicit `dirOverride` (CLI `--dir`) always wins for targetDir
 *
 * Returns a discriminated union: `{ok: true, ...}` on success,
 * `{ok: false, reason, detail}` on validation failure. Discriminate
 * via `r.ok` (explicit boolean per sage P148 cycle 3 — implicit
 * field-absence discriminators are fragile to type drift).
 */
export type ResolvedInitTarget =
  | { ok: true; name: string; targetDir: string }
  | { ok: false; reason: "invalid-name" | "invalid-dir"; detail: string };

export function resolveInitTarget(opts: {
  argName?: string;
  cwd: string;
  dirOverride?: string;
  /**
   * Override the platform for matchBy-basename case-folding (test
   * isolation). Production callers omit this and `os.platform()`
   * decides. Sage P148 cycle 5 — macOS / Windows are case-insensitive
   * by default, so `arc init Foo` in `/x/foo` should match in-place.
   */
  platformOverride?: NodeJS.Platform;
}): ResolvedInitTarget {
  const cwdBasename = basename(opts.cwd);
  const arg = opts.argName?.trim();
  // Case-insensitive match on darwin / win32 (their default filesystems
  // are case-insensitive); strict on linux + others. The actual `name`
  // returned uses the cwd basename's casing when matched, so the
  // manifest reflects what the filesystem actually shows.
  const plat = opts.platformOverride ?? platform();
  const caseInsensitive = plat === "darwin" || plat === "win32";
  const nameMatches =
    arg !== undefined &&
    arg !== "" &&
    arg !== "." &&
    (caseInsensitive
      ? arg.toLowerCase() === cwdBasename.toLowerCase()
      : arg === cwdBasename);
  // `inCwd` decides whether we scaffold in cwd (argless / `.` / matching
  // name) or in a new subdir. Compute once — sage P148 cycle 3 nit.
  const inCwd = !arg || arg === "." || nameMatches;

  const name = inCwd ? cwdBasename : arg!;

  if (!name || /[\/\\]|\.\./.test(name)) {
    return {
      ok: false,
      reason: "invalid-name",
      detail: `"${name}" is not a valid package name (no path separators, no "..", non-empty).`,
    };
  }

  // Sage P148 security: validate `--dir` parity with name. Prevent
  // path-traversal-into-shadow scenarios where a wrapper passes
  // untrusted input through `--dir`.
  if (opts.dirOverride !== undefined) {
    if (opts.dirOverride === "" || /\.\.(\/|\\|$)/.test(opts.dirOverride)) {
      return {
        ok: false,
        reason: "invalid-dir",
        detail: `"${opts.dirOverride}" is not a valid --dir target (no "..", non-empty).`,
      };
    }
  }

  const targetDir =
    opts.dirOverride ?? (inCwd ? opts.cwd : join(opts.cwd, name));

  return { ok: true, name, targetDir };
}

export interface InitResult {
  success: boolean;
  path?: string;
  error?: string;
  files?: string[];
}

/**
 * Scaffold a new skill, tool, agent, or prompt repo directory.
 *
 * arc#107 — `targetDir` may already exist (init-in-place mode). In that
 * case the function refuses only if `arc-manifest.yaml` already lives in
 * the directory (which would mean the cwd is already an arc package);
 * unrelated files are left alone. When `targetDir` does not yet exist,
 * it is created recursively. This matches the ergonomics of `npm init`
 * / `cargo init` / `git init` — the operator's cwd is a valid place to
 * scaffold from.
 */
export async function init(
  targetDir: string,
  name: string,
  author?: string,
  type: ArtifactInitType = "skill"
): Promise<InitResult> {
  // Sage P148 cycles 2 / 3 / 5: refuse when targetDir is unusable.
  // Three distinct cases require slightly different probes:
  //   - regular file at the path → reject ("not a directory")
  //   - symlink pointing at a directory → allow (statSync follows it)
  //   - broken symlink → reject ("broken symlink"); `existsSync` returns
  //     false for broken symlinks so the previous existsSync-gated path
  //     fell through to `mkdir`, which then threw an unhandled EEXIST.
  // `lstatSync` detects the symlink without following it; on a symlink
  // we then follow with `statSync` to distinguish good vs broken.
  let lstat;
  try {
    lstat = lstatSync(targetDir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      return {
        success: false,
        error: `Cannot access ${targetDir}: ${err?.message ?? err}`,
      };
    }
    // Doesn't exist — fine, mkdir below will create it.
    lstat = undefined;
  }
  if (lstat) {
    if (lstat.isSymbolicLink()) {
      try {
        const resolved = statSync(targetDir);
        if (!resolved.isDirectory()) {
          return {
            success: false,
            error: `${targetDir} exists and is not a directory`,
          };
        }
      } catch {
        return {
          success: false,
          error: `${targetDir} is a broken symlink`,
        };
      }
    } else if (!lstat.isDirectory()) {
      return {
        success: false,
        error: `${targetDir} exists and is not a directory`,
      };
    }
  }

  const lowerName = name.replace(/^_/, "").toLowerCase();

  // Sage P148 cycle 3 security: pre-flight check ALL files the scaffold
  // is about to write. Refuse if any exist — arc never overwrites
  // operator content. arc-manifest.yaml gets a dedicated error message
  // because it's the unambiguous "already an arc package" signal; the
  // others share a generic message naming the offending path.
  const filesToWrite = scaffoldFilesFor(type, lowerName);
  for (const rel of filesToWrite) {
    const abs = join(targetDir, rel);
    if (existsSync(abs)) {
      if (rel === "arc-manifest.yaml") {
        return {
          success: false,
          error: `arc-manifest.yaml already exists in ${targetDir} — refusing to overwrite`,
        };
      }
      return {
        success: false,
        error: `Refusing to overwrite existing file: ${abs}`,
      };
    }
  }

  await mkdir(targetDir, { recursive: true });

  const authorName = author ?? "username";
  const files: string[] = [];
  const prefix = `arc-${type}`;

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
