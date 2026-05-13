import { basename, dirname, join } from "path";
import { existsSync, lstatSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { platform } from "os";

export type ArtifactInitType = "skill" | "tool" | "agent" | "prompt" | "pipeline";

/**
 * A single file the scaffold will create. The list returned by
 * {@link scaffoldEntriesFor} is the SOLE source of truth for what
 * `init()` writes — pre-flight overwrite check, mkdir-of-parents, and
 * the actual write loop all iterate the same array. Previously a
 * paths-only `scaffoldFilesFor` array sat parallel to inline
 * `Bun.write` calls, requiring a drift-guard test to catch skew. Sage
 * P148 cycles 4 / 5 / 6 repeatedly flagged the parallel sources as a
 * structural cost; this refactor eliminates the parallelism.
 */
export interface ScaffoldEntry {
  /** Path relative to the scaffold's target directory. */
  path: string;
  /** File contents to write verbatim. */
  content: string;
}

/**
 * Enumerate every file `init()` will create for a given type, with
 * contents. Single source of truth — pre-flight check + writes both
 * iterate this array.
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
 * case the function refuses if `arc-manifest.yaml` already lives there
 * (the "already an arc package" signal) OR if any other scaffold target
 * file already exists (prevents silent clobber of operator content);
 * unrelated files are left alone. When `targetDir` does not yet exist,
 * it is created recursively. Matches the ergonomics of `npm init` /
 * `cargo init` / `git init`.
 *
 * Implementation: all file creation goes through {@link scaffoldEntriesFor}.
 * The pre-flight overwrite check, parent-directory creation, and write
 * loop all iterate the same array — there is no parallel list to drift.
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

  const entries = scaffoldEntriesFor(type, name, author);

  // Sage P148 cycle 3 security: pre-flight check ALL files the scaffold
  // will write. Refuse if any exist — arc never overwrites operator
  // content. `arc-manifest.yaml` gets a dedicated message because it's
  // the unambiguous "already an arc package" signal.
  for (const entry of entries) {
    const abs = join(targetDir, entry.path);
    if (existsSync(abs)) {
      if (entry.path === "arc-manifest.yaml") {
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

  // Create targetDir + every parent implied by entry paths in one pass.
  await mkdir(targetDir, { recursive: true });
  const parentDirs = new Set<string>();
  for (const entry of entries) {
    const dir = dirname(entry.path);
    if (dir !== "." && dir !== "") parentDirs.add(dir);
  }
  for (const dir of parentDirs) {
    await mkdir(join(targetDir, dir), { recursive: true });
  }

  // Write every entry. files[] mirrors entries by construction — no
  // separate `files.push` calls to forget.
  const files: string[] = [];
  for (const entry of entries) {
    await Bun.write(join(targetDir, entry.path), entry.content);
    files.push(entry.path);
  }

  return {
    success: true,
    path: targetDir,
    files,
  };
}

// ── Content builders ────────────────────────────────────────────────────
//
// Pure functions; no side effects. Each returns the file body verbatim.
// Order in the file mirrors the order entries are declared in
// scaffoldEntriesFor for readability.

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
