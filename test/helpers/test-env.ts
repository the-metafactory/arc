/**
 * Test environment helper for pai-pkg.
 *
 * Creates isolated temp directories that simulate the PAI directory structure.
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
  const root = await mkdtemp(join(tmpdir(), "pai-pkg-test-"));

  const paths = createPaths({
    claudeRoot: join(root, ".claude"),
    configRoot: join(root, ".config", "pai"),
    skillsDir: join(root, ".claude", "skills"),
    binDir: join(root, ".claude", "bin"),
    reposDir: join(root, ".config", "pai", "pkg", "repos"),
    dbPath: join(root, ".config", "pai", "packages.db"),
    secretsDir: join(root, ".config", "pai", "secrets"),
    runtimeDir: join(root, ".config", "pai", "skills"),
    catalogPath: join(root, "catalog.yaml"),
    registryPath: join(root, "registry.yaml"),
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
 * The repo has a skill/ dir, pai-manifest.yaml, and optionally src/.
 */
export async function createMockSkillRepo(
  root: string,
  opts: {
    name: string;
    version?: string;
    author?: string;
    withCli?: boolean;
    withoutManifest?: boolean;
    capabilities?: {
      network?: Array<{ domain: string; reason: string }>;
      filesystem?: { read?: string[]; write?: string[] };
      bash?: { allowed: boolean; restricted_to?: string[] };
      secrets?: string[];
    };
  }
): Promise<MockSkillRepo> {
  const repoDir = join(root, `mock-${opts.name}`);

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

  // Create pai-manifest.yaml (unless testing without it)
  if (!opts.withoutManifest) {
    const caps = opts.capabilities ?? {};
    const manifest = {
      name: opts.name,
      version: opts.version ?? "1.0.0",
      type: "skill",
      tier: "custom",
      author: {
        name: opts.author ?? "testuser",
        github: opts.author ?? "testuser",
      },
      provides: {
        skill: [{ trigger: opts.name.replace(/^_/, "").toLowerCase() }],
        ...(opts.withCli
          ? { cli: [{ command: `bun src/tool.ts`, name: opts.name.replace(/^_/, "").toLowerCase() }] }
          : {}),
      },
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: caps.filesystem ?? { read: [], write: [] },
        network: caps.network ?? [],
        bash: caps.bash ?? { allowed: false },
        secrets: caps.secrets ?? [],
      },
    };

    // Write as YAML manually (avoid dependency on yaml in test helper)
    const yaml = buildYaml(manifest);
    await Bun.write(join(repoDir, "pai-manifest.yaml"), yaml);
  }

  // Create src/ if CLI tool
  if (opts.withCli) {
    await Bun.write(
      join(repoDir, "src", "tool.ts"),
      `#!/usr/bin/env bun\nconsole.log("${opts.name} CLI tool");\n`
    );

    await Bun.write(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: `pai-skill-${opts.name.replace(/^_/, "").toLowerCase()}`,
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

/**
 * Simple YAML builder (avoids external dependency in test helper).
 * Only handles the specific pai-manifest structure.
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
