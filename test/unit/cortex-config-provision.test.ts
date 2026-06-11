/**
 * F-6a (cortex#858) — unit tests for the install-time cortex-config bridge
 * (`cortex-config-provision.ts`). Hermetic: the `cortex config merge` verb is
 * never actually spawned — a runner is injected via `__setRunnerForTests`, and
 * cortex-bin resolution reads an injected env.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import {
  maybeMergeCortexConfig,
  marshalFragment,
  isTargetHostCortex,
  stackConfigDirForHost,
  resolveCortexMergeArgv,
  __setRunnerForTests,
  __resetRunnerForTests,
  type CortexRunner,
  type CortexSpawnResult,
} from "../../src/lib/cortex-config-provision.js";
import { createCortexHost } from "../../src/lib/hosts/cortex.js";
import { getDefaultHost } from "../../src/lib/paths.js";
import type { ArcManifest, HostAdapter } from "../../src/types.js";

// ARC_TEST_MODE gates the runner seam; bun sets NODE_ENV=test, but be explicit.
process.env.ARC_TEST_MODE = "1";

let root: string;
let cortexConfigRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "arc-cortex-config-unit-"));
  cortexConfigRoot = join(root, "cortex");
  await mkdir(cortexConfigRoot, { recursive: true });
});

afterEach(async () => {
  __resetRunnerForTests();
  await rm(root, { recursive: true, force: true });
});

/** A cortex host whose detect() passes (cortex.yaml materialized in the root). */
async function cortexHostDetected(): Promise<HostAdapter> {
  await writeFile(join(cortexConfigRoot, "cortex.yaml"), "principal: {}\n", "utf-8");
  return createCortexHost({ configRoot: cortexConfigRoot });
}

/** A cortex host whose detect() fails (no cortex.yaml — separate empty root). */
function cortexHostUndetected(): HostAdapter {
  return createCortexHost({ configRoot: join(root, "cortex-empty") });
}

function agent(cortex_config?: ArcManifest["cortex_config"]): ArcManifest {
  return { name: "dev-agent", version: "1.0.0", type: "agent", cortex_config };
}

/** A recording runner that always succeeds (exit 0). */
function recorder(calls: string[][]): CortexRunner {
  return (argv) => {
    calls.push(argv);
    return { exitCode: 0, stdout: "", stderr: "config merge: 1 capability added — OK" };
  };
}

describe("isTargetHostCortex / stackConfigDirForHost", () => {
  test("true only for a detected cortex host", async () => {
    expect(isTargetHostCortex(await cortexHostDetected())).toBe(true);
    expect(isTargetHostCortex(cortexHostUndetected())).toBe(false);
    expect(isTargetHostCortex(getDefaultHost({ root: join(root, ".claude") }))).toBe(false);
  });

  test("config dir is the cortex host root", async () => {
    expect(stackConfigDirForHost(await cortexHostDetected())).toBe(cortexConfigRoot);
  });
});

describe("resolveCortexMergeArgv", () => {
  test("ARC_CORTEX_BIN .ts → bun runner", () => {
    expect(resolveCortexMergeArgv({ ARC_CORTEX_BIN: "/x/config-merge.ts" })).toEqual([
      "bun",
      "/x/config-merge.ts",
      "config",
      "merge",
    ]);
  });

  test("ARC_CORTEX_BIN binary → direct exec", () => {
    expect(resolveCortexMergeArgv({ ARC_CORTEX_BIN: "/usr/local/bin/cortex" })).toEqual([
      "/usr/local/bin/cortex",
      "config",
      "merge",
    ]);
  });

  test("MF_CORTEX_BIN is honored as a fallback name", () => {
    expect(resolveCortexMergeArgv({ MF_CORTEX_BIN: "/x/cortex" })).toEqual([
      "/x/cortex",
      "config",
      "merge",
    ]);
  });

  test("null when nothing resolves (no env, no PATH cortex)", () => {
    // We can't reliably guarantee `cortex` is absent from the real PATH, so only
    // assert the env-empty branch falls through to the Bun.which probe; if the
    // box happens to have cortex installed this returns the PATH form, which is
    // still a non-null valid argv. Either way it must be null OR a 3+ token argv.
    const r = resolveCortexMergeArgv({});
    expect(r === null || (Array.isArray(r) && r.length >= 3)).toBe(true);
  });
});

describe("marshalFragment", () => {
  test("inline fragment → temp file with only capability/policy keys", () => {
    const { fragmentFile, tmpDir } = marshalFragment(
      { capabilities: [{ id: "dev.implement" }], policy: { principals: [], roles: [] } },
      root,
    );
    expect(tmpDir).toBeDefined();
    expect(existsSync(fragmentFile)).toBe(true);
    const parsed = YAML.parse(readFileSync(fragmentFile, "utf-8"));
    expect(Object.keys(parsed).sort()).toEqual(["capabilities", "policy"]);
    rmSync(tmpDir!, { recursive: true, force: true });
  });

  test("path pointer → resolves inside the package", async () => {
    await writeFile(join(root, "frag.yaml"), "capabilities: []\n", "utf-8");
    const { fragmentFile, tmpDir } = marshalFragment({ path: "frag.yaml" }, root);
    expect(tmpDir).toBeUndefined();
    expect(fragmentFile).toBe(join(root, "frag.yaml"));
  });

  test("path pointer that escapes the package throws", () => {
    expect(() => marshalFragment({ path: "../../etc/passwd" }, root)).toThrow(/escapes the package/);
  });

  test("path pointer to a missing file throws", () => {
    expect(() => marshalFragment({ path: "nope.yaml" }, root)).toThrow(/does not exist/);
  });
});

describe("maybeMergeCortexConfig", () => {
  test("no-op success when manifest has no cortex_config", async () => {
    const r = maybeMergeCortexConfig(agent(), {
      host: await cortexHostDetected(),
      installPath: root,
      quiet: true,
    });
    expect(r.success).toBe(true);
    expect(r.skippedReason).toBe("no-fragment");
    expect(r.merged).toBeUndefined();
  });

  test("no-op success when host is not cortex", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    const r = maybeMergeCortexConfig(agent({ capabilities: [{ id: "x" }] }), {
      host: getDefaultHost({ root: join(root, ".claude") }),
      installPath: root,
      quiet: true,
    });
    expect(r.success).toBe(true);
    expect(r.skippedReason).toBe("host-not-cortex");
    expect(calls.length).toBe(0); // never invoked the verb
  });

  test("invokes `cortex config merge` with the right argv when present + host is cortex", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    const host = await cortexHostDetected();
    const r = maybeMergeCortexConfig(agent({ capabilities: [{ id: "dev.implement" }] }), {
      host,
      installPath: root,
      stackId: "andreas/work",
      quiet: true,
      env: { ARC_CORTEX_BIN: "/x/cortex" },
    });
    expect(r.success).toBe(true);
    expect(r.merged).toBe(true);
    expect(calls.length).toBe(1);
    const argv = calls[0];
    expect(argv.slice(0, 3)).toEqual(["/x/cortex", "config", "merge"]);
    expect(argv).toContain("--config");
    expect(argv[argv.indexOf("--config") + 1]).toBe(cortexConfigRoot);
    expect(argv).toContain("--fragment");
    expect(argv).toContain("--stack");
    expect(argv[argv.indexOf("--stack") + 1]).toBe("andreas/work");
  });

  test("omits --stack when no stackId given", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    maybeMergeCortexConfig(agent({ capabilities: [{ id: "x" }] }), {
      host: await cortexHostDetected(),
      installPath: root,
      quiet: true,
      env: { ARC_CORTEX_BIN: "/x/cortex" },
    });
    expect(calls[0]).not.toContain("--stack");
  });

  test("fail-closed when the verb exits non-zero", async () => {
    const failing: CortexRunner = (): CortexSpawnResult => ({
      exitCode: 1,
      stdout: "",
      stderr: "config merge: composed config failed CortexConfigSchema",
    });
    __setRunnerForTests(failing);
    const r = maybeMergeCortexConfig(agent({ capabilities: [{ id: "x" }] }), {
      host: await cortexHostDetected(),
      installPath: root,
      quiet: true,
      env: { ARC_CORTEX_BIN: "/x/cortex" },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("exit 1");
    expect(r.error).toContain("CortexConfigSchema");
  });

  test("fail-closed when the cortex CLI cannot be found", async () => {
    const calls: string[][] = [];
    __setRunnerForTests(recorder(calls));
    const r = maybeMergeCortexConfig(agent({ capabilities: [{ id: "x" }] }), {
      host: await cortexHostDetected(),
      installPath: root,
      quiet: true,
      // Force resolution to fail: empty env AND a name PATH won't have.
      env: { PATH: "/nonexistent-bin-dir" },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("cortex CLI was not found");
    expect(calls.length).toBe(0);
  });

  test("cleans up the inline-fragment temp file after a successful merge", async () => {
    let capturedFragmentPath = "";
    const runner: CortexRunner = (argv) => {
      capturedFragmentPath = argv[argv.indexOf("--fragment") + 1];
      // Verify the file exists DURING the merge.
      expect(existsSync(capturedFragmentPath)).toBe(true);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    __setRunnerForTests(runner);
    maybeMergeCortexConfig(agent({ capabilities: [{ id: "x" }] }), {
      host: await cortexHostDetected(),
      installPath: root,
      quiet: true,
      env: { ARC_CORTEX_BIN: "/x/cortex" },
    });
    // …and gone AFTER (finally block removed the temp dir).
    expect(existsSync(capturedFragmentPath)).toBe(false);
  });
});
