/**
 * F-6a (cortex#858) end-to-end: cortex config composition through `install()`.
 *
 * Drives the install flow against a cortex host and asserts the cortex-config
 * step fires exactly when (a) the manifest declares `cortex_config` AND (b) the
 * target host is a detected cortex stack. The `cortex config merge` verb is
 * never actually spawned — a runner is injected via `__setRunnerForTests` and
 * cortex-bin resolution is pinned via ARC_CORTEX_BIN.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { Database } from "bun:sqlite";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { createCortexHost } from "../../src/lib/hosts/cortex.js";
import {
  __setRunnerForTests,
  __resetRunnerForTests,
  type CortexRunner,
} from "../../src/lib/cortex-config-provision.js";
import { getSkill } from "../../src/lib/db.js";

process.env.ARC_TEST_MODE = "1";

let env: TestEnv;
let cortexRoot: string;
let prevCortexBin: string | undefined;

beforeEach(async () => {
  env = await createTestEnv();
  cortexRoot = join(env.root, "cortex");
  await mkdir(cortexRoot, { recursive: true });
  // Materialize cortex.yaml so the cortex host's detect() passes.
  await writeFile(join(cortexRoot, "cortex.yaml"), "principal: {}\n", "utf-8");
  prevCortexBin = process.env.ARC_CORTEX_BIN;
  process.env.ARC_CORTEX_BIN = "/x/cortex"; // pin resolution; runner is mocked anyway
});

afterEach(async () => {
  __resetRunnerForTests();
  if (prevCortexBin === undefined) delete process.env.ARC_CORTEX_BIN;
  else process.env.ARC_CORTEX_BIN = prevCortexBin;
  await env.cleanup();
});

/** Build a git-backed agent repo whose manifest carries an optional cortex_config. */
async function makeAgentRepo(
  name: string,
  cortex_config?: Record<string, unknown>,
): Promise<string> {
  const repoDir = join(env.root, `mock-${name}`);
  await mkdir(join(repoDir, "agent"), { recursive: true });
  await writeFile(
    join(repoDir, "agent", `${name}.md`),
    `---\nname: ${name}\ndescription: mock\nmodel: sonnet\n---\n# ${name}\n`,
    "utf-8",
  );
  const manifest: Record<string, unknown> = {
    name,
    version: "1.0.0",
    type: "agent",
    tier: "custom",
    author: { name: "t", github: "t" },
    ...(cortex_config ? { cortex_config } : {}),
  };
  await writeFile(join(repoDir, "arc-manifest.yaml"), YAML.stringify(manifest), "utf-8");
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@t.com", "commit", "-m", "init"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  return repoDir;
}

function cortexHost() {
  return createCortexHost({ configRoot: cortexRoot });
}

function recorder(calls: string[][]): CortexRunner {
  return (argv) => {
    calls.push(argv);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("install() — F-6a cortex config composition", () => {
  test("invokes the merge when cortex_config present + host is cortex", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    const repo = await makeAgentRepo("dev-agent", { capabilities: [{ id: "dev.implement" }] });

    const result = await install({
      arc: env.arc,
      host: cortexHost(),
      db: env.db,
      repoUrl: repo,
      yes: true,
      cortexStackId: "andreas/work",
    });

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].slice(0, 3)).toEqual(["/x/cortex", "config", "merge"]);
    expect(calls[0][calls[0].indexOf("--config") + 1]).toBe(cortexRoot);
    expect(calls[0][calls[0].indexOf("--stack") + 1]).toBe("andreas/work");
    // Package landed in the DB.
    expect(getSkill(env.db, "dev-agent")?.status).toBe("active");
  });

  test("skips the merge when manifest has no cortex_config", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    const repo = await makeAgentRepo("plain-agent");

    const result = await install({
      arc: env.arc,
      host: cortexHost(),
      db: env.db,
      repoUrl: repo,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("skips the merge when the host is NOT cortex (claude-code)", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    const repo = await makeAgentRepo("dev-agent", { capabilities: [{ id: "dev.implement" }] });

    const result = await install({
      arc: env.arc,
      host: env.host, // default claude-code host
      db: env.db,
      repoUrl: repo,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(calls.length).toBe(0);
    // Still installed onto the claude-code host (cortex doesn't host agents in
    // this path, but the agent .md symlink lands via the default host).
    expect(getSkill(env.db, "dev-agent")?.status).toBe("active");
  });

  test("fails CLOSED + rolls back the DB row when the merge fails", async () => {
    const failing: CortexRunner = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "config merge: composed config failed CortexConfigSchema",
    });
    __setRunnerForTests(failing);
    const repo = await makeAgentRepo("dev-agent", { capabilities: [{ id: "dev.implement" }] });

    const result = await install({
      arc: env.arc,
      host: cortexHost(),
      db: env.db,
      repoUrl: repo,
      yes: true,
      cortexStackId: "andreas/work",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cortex config merge");
    // Fail-closed rollback: the DB row that the transaction committed is unwound.
    const db = new Database(env.arc.dbPath, { readonly: true });
    try {
      const row = db.query("SELECT status FROM skills WHERE name = 'dev-agent'").get() as
        | { status: string }
        | null;
      // Either no row, or not active — the install did not stick.
      expect(row?.status === "active").toBe(false);
    } finally {
      db.close();
    }
  });

  test("a retry after a transient merge failure succeeds (idempotent verb)", async () => {
    // First attempt: merge fails → install fails closed, nothing sticks.
    let attempt = 0;
    const flaky: CortexRunner = () => {
      attempt += 1;
      return attempt === 1
        ? { exitCode: 1, stdout: "", stderr: "transient broker error" }
        : { exitCode: 0, stdout: "", stderr: "config merge: idempotent no-op — OK" };
    };
    __setRunnerForTests(flaky);
    const repo = await makeAgentRepo("dev-agent", { capabilities: [{ id: "dev.implement" }] });

    const first = await install({
      arc: env.arc,
      host: cortexHost(),
      db: env.db,
      repoUrl: repo,
      yes: true,
      cortexStackId: "andreas/work",
    });
    expect(first.success).toBe(false);

    // Retry: same package, merge now succeeds.
    const second = await install({
      arc: env.arc,
      host: cortexHost(),
      db: env.db,
      repoUrl: repo,
      yes: true,
      cortexStackId: "andreas/work",
    });
    expect(second.success).toBe(true);
    expect(getSkill(env.db, "dev-agent")?.status).toBe("active");
  });
});
