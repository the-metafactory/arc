import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, lstat, readlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSymlink,
  removeSymlink,
  SymlinkConflictError,
  createCliShim,
  removeCliShim,
} from "../../src/lib/symlinks.js";
import type { ArcManifest } from "../../src/types.js";

function cliManifest(cli: { command: string; name?: string }[]): ArcManifest {
  return { name: "soma", version: "1.0.0", type: "tool", provides: { cli } };
}

let root: string;

beforeEach(async () => {
  root = join(
    tmpdir(),
    `arc-symlinks-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createSymlink", () => {
  test("creates a symlink at the target path", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "hello");

    await createSymlink(target, link);

    const stat = await lstat(link);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
  });

  test("replaces an existing symlink", async () => {
    const targetA = join(root, "a");
    const targetB = join(root, "b");
    const link = join(root, "link");
    await writeFile(targetA, "a");
    await writeFile(targetB, "b");

    await createSymlink(targetA, link);
    await createSymlink(targetB, link);

    expect(await readlink(link)).toBe(targetB);
  });

  test("renames an existing directory aside as .pre-arc", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "hello");
    await mkdir(link);
    await writeFile(join(link, "operator-data.txt"), "important");

    await createSymlink(target, link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const backupDir = link + ".pre-arc";
    expect(existsSync(backupDir)).toBe(true);
    expect(existsSync(join(backupDir, "operator-data.txt"))).toBe(true);
  });

  // arc#163: install must not silently destroy a regular file at the link path
  // (uninstall treats non-symlinks as operator-owned state — install needs to
  // be symmetric).
  test("arc#163: refuses to overwrite a regular file (typed SymlinkConflictError)", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "package data");
    await writeFile(link, "operator data");

    let err: unknown;
    try {
      await createSymlink(target, link);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SymlinkConflictError);
    expect((err as SymlinkConflictError).code).toBe("ARC_SYMLINK_CONFLICT");
    expect((err as SymlinkConflictError).linkPath).toBe(link);
    expect((err as SymlinkConflictError).message).toContain("regular file");

    // The operator's file must still be there, unmodified.
    expect(existsSync(link)).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await Bun.file(link).text()).toBe("operator data");
  });
});

describe("removeSymlink", () => {
  test("removes an existing symlink and returns true", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "hello");
    await createSymlink(target, link);

    const removed = await removeSymlink(link);

    expect(removed).toBe(true);
    expect(existsSync(link)).toBe(false);
  });

  test("returns false when the path doesn't exist", async () => {
    const removed = await removeSymlink(join(root, "missing"));
    expect(removed).toBe(false);
  });

  test("returns false (without unlinking) when the path is a regular file", async () => {
    const file = join(root, "file");
    await writeFile(file, "operator data");

    const removed = await removeSymlink(file);

    expect(removed).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

describe("createCliShim", () => {
  test("POSIX: writes an extensionless #!/bin/bash shim", async () => {
    const shimDir = join(root, "shim");
    const binDir = join(root, "bin");

    const created = await createCliShim(
      shimDir,
      binDir,
      cliManifest([{ name: "soma", command: "bun src/cli.ts" }]),
      "linux",
    );

    expect(created).toEqual(["soma"]);
    const shimPath = join(shimDir, "soma");
    expect(existsSync(shimPath)).toBe(true);
    expect(existsSync(join(shimDir, "soma.cmd"))).toBe(false);

    const content = await Bun.file(shimPath).text();
    expect(content.startsWith("#!/bin/bash")).toBe(true);
    expect(content).toContain(`cd "${join(binDir, "soma")}"`);
    expect(content).toContain('exec bun run src/cli.ts "$@"');

    // soma#315: capture the caller's working directory before the `cd`
    // into the bin dir, so wrapped CLIs can resolve relative path args
    // (e.g. `soma export --out ./preview`) against the user's shell dir
    // instead of the repo root. Captured via the `pwd` builtin (not the
    // inherited `$PWD`, which can be stale/forged); `${VAR:-$(pwd)}` keeps
    // an outer value when one arc CLI shells out to another.
    expect(content).toContain('export ARC_INVOCATION_CWD="${ARC_INVOCATION_CWD:-$(pwd)}"');
    expect(content.indexOf("ARC_INVOCATION_CWD")).toBeLessThan(content.indexOf('cd "'));
  });

  test("Windows: writes a .cmd launcher, not a bash shim", async () => {
    const shimDir = join(root, "shim");
    const binDir = join(root, "bin");

    const created = await createCliShim(
      shimDir,
      binDir,
      cliManifest([{ name: "soma", command: "bun src/cli.ts" }]),
      "win32",
    );

    // Returns the logical bin name, not the on-disk filename.
    expect(created).toEqual(["soma"]);
    const cmdPath = join(shimDir, "soma.cmd");
    expect(existsSync(cmdPath)).toBe(true);
    // No extensionless shim — that's the bug being fixed (Windows can't run it).
    expect(existsSync(join(shimDir, "soma"))).toBe(false);

    const content = await Bun.file(cmdPath).text();
    expect(content.startsWith("@echo off")).toBe(true);
    expect(content).toContain("setlocal");
    expect(content).toContain(`cd /d "${join(binDir, "soma")}"`);
    expect(content).toContain("bun run src/cli.ts %*");
    expect(content).not.toContain("#!/bin/bash");

    // soma#315: capture the caller's cwd before `cd /d`, mirroring the
    // POSIX shim. `if not defined` preserves an outer value across nested
    // arc CLI invocations.
    expect(content).toContain('if not defined ARC_INVOCATION_CWD set "ARC_INVOCATION_CWD=%CD%"');
    expect(content.indexOf("ARC_INVOCATION_CWD")).toBeLessThan(content.indexOf("cd /d"));
  });

  test("non-bun command: invoked relative to the bin dir on both platforms", async () => {
    const shimDir = join(root, "shim");
    const binDir = join(root, "bin");
    const manifest = cliManifest([{ name: "tool", command: "run.sh" }]);

    await createCliShim(shimDir, binDir, manifest, "linux");
    expect(await Bun.file(join(shimDir, "tool")).text()).toContain(
      'exec ./run.sh "$@"',
    );

    // Pin the full invocation line: `.\` keeps resolution inside the bin dir.
    // A bare `run.sh %*` would let cmd.exe resolve a same-named program
    // elsewhere on PATH instead of the installed one.
    await createCliShim(shimDir, binDir, manifest, "win32");
    expect(await Bun.file(join(shimDir, "tool.cmd")).text()).toContain(
      "\r\n.\\run.sh %*\r\n",
    );
  });

  test("no CLI entries: creates nothing and returns []", async () => {
    const shimDir = join(root, "shim");

    const created = await createCliShim(
      shimDir,
      join(root, "bin"),
      cliManifest([]),
      "win32",
    );

    expect(created).toEqual([]);
    expect(existsSync(shimDir)).toBe(false);
  });
});

describe("removeCliShim", () => {
  test("POSIX: removes the extensionless shim", async () => {
    const shimDir = join(root, "shim");
    await mkdir(shimDir, { recursive: true });
    await writeFile(join(shimDir, "soma"), "#!/bin/bash\n");

    expect(await removeCliShim(shimDir, "soma", "linux")).toBe(true);
    expect(existsSync(join(shimDir, "soma"))).toBe(false);
  });

  test("Windows: removes the .cmd shim", async () => {
    const shimDir = join(root, "shim");
    await mkdir(shimDir, { recursive: true });
    await writeFile(join(shimDir, "soma.cmd"), "@echo off\n");

    expect(await removeCliShim(shimDir, "soma", "win32")).toBe(true);
    expect(existsSync(join(shimDir, "soma.cmd"))).toBe(false);
  });

  test("Windows: also sweeps a legacy extensionless shim", async () => {
    const shimDir = join(root, "shim");
    await mkdir(shimDir, { recursive: true });
    // Simulates a shim written by a pre-fix arc, with no matching .cmd.
    await writeFile(join(shimDir, "soma"), "#!/bin/bash\n");

    expect(await removeCliShim(shimDir, "soma", "win32")).toBe(true);
    expect(existsSync(join(shimDir, "soma"))).toBe(false);
  });

  test("returns false when no shim exists", async () => {
    expect(await removeCliShim(join(root, "shim"), "soma", "win32")).toBe(false);
  });
});
