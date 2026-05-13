/**
 * Tests for arc#140 P1: runLifecycleScripts — ordered array runner.
 *
 * Sister to the existing runScript single-script tests. Verifies:
 *   - empty array → no-op success
 *   - declared order is preserved
 *   - first failure halts subsequent scripts
 *   - missing files are treated as skip (consistent with runScript)
 *   - env vars are passed through to each script
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runLifecycleScripts } from "../../src/lib/scripts.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-i140-lifecycle-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeScript(name: string, body: string): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
  return name;
}

describe("runLifecycleScripts", () => {
  test("empty array → success no-op", () => {
    const result = runLifecycleScripts({
      installPath: tempDir,
      scriptPaths: [],
      phase: "postinstall",
      quiet: true,
    });
    expect(result.success).toBe(true);
    expect(result.steps).toEqual([]);
    expect(result.failedAt).toBeUndefined();
  });

  test("runs scripts in declared order", async () => {
    const logFile = join(tempDir, "log.txt");
    await writeScript("a.sh", `echo "A" >> "${logFile}"`);
    await writeScript("b.sh", `echo "B" >> "${logFile}"`);
    await writeScript("c.sh", `echo "C" >> "${logFile}"`);

    const result = runLifecycleScripts({
      installPath: tempDir,
      scriptPaths: ["a.sh", "b.sh", "c.sh"],
      phase: "postinstall",
      quiet: true,
    });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((s) => s.scriptPath)).toEqual([
      "a.sh",
      "b.sh",
      "c.sh",
    ]);

    const log = await Bun.file(logFile).text();
    expect(log).toBe("A\nB\nC\n");
  });

  test("halts after first failure; later scripts not run", async () => {
    const logFile = join(tempDir, "log.txt");
    await writeScript("ok.sh", `echo "OK" >> "${logFile}"`);
    await writeScript("fail.sh", `echo "FAIL" >> "${logFile}"\nexit 7`);
    await writeScript("never.sh", `echo "NEVER" >> "${logFile}"`);

    const result = runLifecycleScripts({
      installPath: tempDir,
      scriptPaths: ["ok.sh", "fail.sh", "never.sh"],
      phase: "postinstall",
      quiet: true,
    });
    expect(result.success).toBe(false);
    expect(result.failedAt).toBe("fail.sh");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].exitCode).toBe(7);

    const log = await Bun.file(logFile).text();
    expect(log).toBe("OK\nFAIL\n");
  });

  test("missing script file is a skip, not a failure", async () => {
    await writeScript("present.sh", `true`);

    const result = runLifecycleScripts({
      installPath: tempDir,
      scriptPaths: ["missing.sh", "present.sh"],
      phase: "postinstall",
      quiet: true,
    });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].skipped).toBe(true);
    expect(result.steps[1].skipped).toBe(false);
  });

  test("passes env vars to each script", async () => {
    const outFile = join(tempDir, "out.txt");
    await writeScript("env.sh", `echo "VAR=$ARC_I140_TEST_VAR" > "${outFile}"`);

    const result = runLifecycleScripts({
      installPath: tempDir,
      scriptPaths: ["env.sh"],
      phase: "postinstall",
      quiet: true,
      env: { ARC_I140_TEST_VAR: "hello" },
    });
    expect(result.success).toBe(true);

    const out = await Bun.file(outFile).text();
    expect(out.trim()).toBe("VAR=hello");
  });

  test("PAI_HOOK env var matches phase name", async () => {
    const outFile = join(tempDir, "out.txt");
    await writeScript("phase.sh", `echo "$PAI_HOOK" > "${outFile}"`);

    runLifecycleScripts({
      installPath: tempDir,
      scriptPaths: ["phase.sh"],
      phase: "preuninstall",
      quiet: true,
    });

    const out = await Bun.file(outFile).text();
    expect(out.trim()).toBe("preuninstall");
  });
});
