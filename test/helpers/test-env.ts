/**
 * Test environment helper for arc.
 *
 * Creates isolated temp directories that simulate the arc directory structure.
 * Every test gets its own fresh environment — no cross-test contamination.
 */

import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { createPaths } from "../../src/lib/paths.js";
import { openDatabase } from "../../src/lib/db.js";
import { ensureDirectories } from "../../src/lib/paths.js";
import type { PaiPaths } from "../../src/types.js";

export interface TestEnv {
  /** Root temp directory for this test */
  root: string;
  /** PaiPaths pointing to temp directories */
  paths: PaiPaths;
  /** Open database for this test */
  db: Database;
  /** Clean up temp directory and close database */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test environment.
 * Call cleanup() when done.
 */
export async function createTestEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), "arc-test-"));

  const paths = createPaths({
    claudeRoot: join(root, ".claude"),
    configRoot: join(root, ".config", "pai"),
    skillsDir: join(root, ".claude", "skills"),
    agentsDir: join(root, ".claude", "agents"),
    promptsDir: join(root, ".claude", "commands"),
    binDir: join(root, ".claude", "bin"),
    shimDir: join(root, "bin"),
    reposDir: join(root, ".config", "pai", "pkg", "repos"),
    dbPath: join(root, ".config", "pai", "packages.db"),
    secretsDir: join(root, ".config", "pai", "secrets"),
    runtimeDir: join(root, ".config", "pai", "skills"),
    catalogPath: join(root, "catalog.yaml"),
    registryPath: join(root, "registry.yaml"),
    sourcesPath: join(root, ".config", "pai", "sources.yaml"),
    cachePath: join(root, ".config", "pai", "pkg", "cache"),
    actionsDir: join(root, ".config", "pai", "actions"),
    settingsPath: join(root, ".claude", "settings.json"),
  });

  await ensureDirectories(paths);
  const db = openDatabase(paths.dbPath);

  return {
    root,
    paths,
    db,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface MockSkillRepo {
  /** Path to the mock skill repo */
  path: string;
  /** Git repo URL (local path, usable by git clone) */
  url: string;
}

/**
 * Create a mock skill repo with git initialized.
 * The repo has a skill/ dir, arc-manifest.yaml, and optionally src/.
 */
export async function createMockSkillRepo(
  root: string,
  opts: {
    name: string;
    version?: string;
    author?: string;
    /** Use authors array format instead of singular author */
    authors?: Array<{ name: string; github: string }>;
    /** Artifact type: skill (default), tool, agent, prompt, component, pipeline, action */
    type?: "skill" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "action";
    withCli?: boolean;
    withoutManifest?: boolean;
    capabilities?: {
      network?: Array<{ domain: string; reason: string }>;
      filesystem?: { read?: string[]; write?: string[] };
      bash?: { allowed: boolean; restricted_to?: string[] };
      secrets?: string[];
    };
    /** Additional CLI entries beyond the default one */
    extraCli?: Array<{ name: string; command: string }>;
    /** Lifecycle scripts to declare in the manifest and create on disk */
    scripts?: {
      preinstall?: { path: string; content: string };
      postinstall?: { path: string; content: string };
      preupgrade?: { path: string; content: string };
      postupgrade?: { path: string; content: string };
    };
  }
): Promise<MockSkillRepo> {
  const repoDir = join(root, `mock-${opts.name}`);
  const artifactType = opts.type ?? "skill";

  if (artifactType === "skill") {
    // Create skill directory
    const skillDir = join(repoDir, "skill");
    await Bun.write(
      join(skillDir, "SKILL.md"),
      `---\nname: ${opts.name}\ndescription: Mock skill for testing\n---\n\n# ${opts.name}\n\nTest skill.\n`
    );

    await Bun.write(
      join(skillDir, "workflows", "Main.md"),
      `# Main Workflow\n\n1. Do the thing\n`
    );
  } else if (artifactType === "tool") {
    // Tools: CLI entry point at root
    await Bun.write(
      join(repoDir, "src", "tool.ts"),
      `#!/usr/bin/env bun\nconsole.log("${opts.name} CLI tool");\n`
    );
    await Bun.write(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: `arc-tool-${opts.name.toLowerCase()}`,
          version: opts.version ?? "1.0.0",
          type: "module",
        },
        null,
        2
      ) + "\n"
    );
  } else if (artifactType === "agent") {
    // Agents: single markdown file in agent/ subdir
    const agentDir = join(repoDir, "agent");
    await Bun.write(
      join(agentDir, `${opts.name}.md`),
      `---\nname: ${opts.name}\ndescription: Mock agent for testing\nmodel: sonnet\n---\n\n# ${opts.name}\n\nTest agent persona.\n`
    );
  } else if (artifactType === "prompt") {
    // Prompts: single markdown file in prompt/ subdir
    const promptDir = join(repoDir, "prompt");
    await Bun.write(
      join(promptDir, `${opts.name}.md`),
      `---\nname: ${opts.name}\ndescription: Mock prompt for testing\n---\n\n# ${opts.name}\n\nTest prompt/command.\n`
    );
  }

  // Create lifecycle script files if declared
  if (opts.scripts) {
    for (const [, script] of Object.entries(opts.scripts)) {
      const scriptAbsPath = join(repoDir, script.path);
      await Bun.write(scriptAbsPath, script.content);
      // Make executable
      Bun.spawnSync(["chmod", "+x", scriptAbsPath], { stdout: "pipe", stderr: "pipe" });
    }
  }

  // Create arc-manifest.yaml (unless testing without it)
  if (!opts.withoutManifest) {
    const caps = opts.capabilities ?? {};
    const isTool = artifactType === "tool";
    const manifest = {
      name: opts.name,
      version: opts.version ?? "1.0.0",
      type: artifactType,
      tier: "custom",
      ...(opts.authors
        ? { authors: opts.authors }
        : { author: { name: opts.author ?? "testuser", github: opts.author ?? "testuser" } }),
      provides: {
        ...(artifactType === "skill"
          ? { skill: [{ trigger: opts.name.replace(/^_/, "").toLowerCase() }] }
          : {}),
        ...(opts.withCli || isTool
          ? { cli: [
              { command: `bun src/tool.ts`, name: opts.name.replace(/^_/, "").toLowerCase() },
              ...(opts.extraCli ?? []),
            ] }
          : {}),
      },
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: caps.filesystem ?? { read: [], write: [] },
        network: caps.network ?? [],
        bash: caps.bash ?? { allowed: false },
        secrets: caps.secrets ?? [],
      },
      ...(opts.scripts ? {
        scripts: Object.fromEntries(
          Object.entries(opts.scripts).map(([hook, s]) => [hook, s.path])
        ),
      } : {}),
    };

    // Write as YAML manually (avoid dependency on yaml in test helper)
    const yaml = buildYaml(manifest);
    await Bun.write(join(repoDir, "arc-manifest.yaml"), yaml);
  }

  // Create src/ if CLI tool (for skills with CLI)
  if (opts.withCli && artifactType === "skill") {
    await Bun.write(
      join(repoDir, "src", "tool.ts"),
      `#!/usr/bin/env bun\nconsole.log("${opts.name} CLI tool");\n`
    );

    await Bun.write(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: `arc-skill-${opts.name.replace(/^_/, "").toLowerCase()}`,
          version: opts.version ?? "1.0.0",
          type: "module",
        },
        null,
        2
      ) + "\n"
    );
  }

  // Initialize git repo and commit
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "Initial commit"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );

  return {
    path: repoDir,
    url: repoDir, // git clone accepts local paths
  };
}

export interface MockLibraryRepo {
  path: string;
  url: string;
}

/**
 * Create a mock library repo with multiple artifacts for testing.
 */
export async function createMockLibraryRepo(
  root: string,
  opts: {
    name: string;
    version?: string;
    author?: string;
    artifacts: Array<{
      path: string;
      name: string;
      type: "skill" | "tool" | "agent" | "prompt" | "pipeline" | "component" | "action";
      version?: string;
      description?: string;
    }>;
  }
): Promise<MockLibraryRepo> {
  const repoDir = join(root, `mock-lib-${opts.name}`);

  // Create root manifest
  const rootManifest = {
    schema: "arc/v1",
    name: opts.name,
    version: opts.version ?? "1.0.0",
    type: "library",
    author: { name: opts.author ?? "testuser", github: opts.author ?? "testuser" },
    description: `Mock library ${opts.name}`,
    artifacts: opts.artifacts.map((a) => ({
      path: a.path,
      description: a.description ?? `${a.name} artifact`,
    })),
  };

  await Bun.write(join(repoDir, "arc-manifest.yaml"), buildYaml(rootManifest));

  // Create each artifact subdirectory with its own manifest
  for (const artifact of opts.artifacts) {
    const artifactDir = join(repoDir, artifact.path);

    const artifactManifest = {
      schema: "arc/v1",
      name: artifact.name,
      version: artifact.version ?? "1.0.0",
      type: artifact.type,
      author: { name: opts.author ?? "testuser", github: opts.author ?? "testuser" },
      provides: artifact.type === "skill"
        ? { skill: [{ trigger: artifact.name.toLowerCase() }] }
        : {},
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: { read: ["./"], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    };

    await Bun.write(join(artifactDir, "arc-manifest.yaml"), buildYaml(artifactManifest));

    // Create type-specific content
    if (artifact.type === "skill") {
      await Bun.write(
        join(artifactDir, "skill", "SKILL.md"),
        `# ${artifact.name}\n\nTest skill.\n`
      );
    } else if (artifact.type === "agent") {
      await Bun.write(
        join(artifactDir, "agent", `${artifact.name}.md`),
        `# ${artifact.name}\n\nTest agent.\n`
      );
    } else if (artifact.type === "prompt") {
      await Bun.write(
        join(artifactDir, "prompt", `${artifact.name}.md`),
        `# ${artifact.name}\n\nTest prompt.\n`
      );
    }
  }

  // Initialize git repo
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "Initial commit"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );

  return { path: repoDir, url: repoDir };
}

/**
 * Simple YAML builder (avoids external dependency in test helper).
 * Only handles the specific arc-manifest structure.
 */
function buildYaml(obj: any, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;

    if (Array.isArray(val)) {
      if (val.length === 0) {
        out += `${pad}${key}: []\n`;
      } else if (typeof val[0] === "object") {
        out += `${pad}${key}:\n`;
        for (const item of val) {
          const entries = Object.entries(item);
          out += `${pad}  - ${entries[0][0]}: ${JSON.stringify(entries[0][1])}\n`;
          for (let i = 1; i < entries.length; i++) {
            out += `${pad}    ${entries[i][0]}: ${JSON.stringify(entries[i][1])}\n`;
          }
        }
      } else {
        out += `${pad}${key}:\n`;
        for (const item of val) {
          out += `${pad}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else if (typeof val === "object") {
      out += `${pad}${key}:\n`;
      out += buildYaml(val, indent + 1);
    } else if (typeof val === "boolean") {
      out += `${pad}${key}: ${val}\n`;
    } else {
      out += `${pad}${key}: ${val}\n`;
    }
  }

  return out;
}
