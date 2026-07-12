import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, lstat, readlink, unlink, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSymlink,
  removeSymlink,
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

  // arc#293 (XDG wave 3): occupied-destination preflight. A regular file in the
  // way (e.g. the live `~/.local/bin/{cldyo-live,lucid}` files that predate the
  // bin cutover) must NOT abort the install — it is backed up to a `.pre-arc`
  // sidecar (preserving operator data, arc#163's core guarantee) and the symlink
  // is created over the vacated path so the cutover completes.
  test("arc#293: backs up an occupying regular file to .pre-arc, then links", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "package data");
    await writeFile(link, "operator data");

    await createSymlink(target, link);

    // The link now points at the package target.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);

    // The operator's original file survives, unmodified, at the sidecar.
    const sidecar = link + ".pre-arc";
    expect(existsSync(sidecar)).toBe(true);
    expect((await lstat(sidecar)).isFile()).toBe(true);
    expect(await Bun.file(sidecar).text()).toBe("operator data");
  });

  test("arc#293: replaces a stale arc-managed symlink in place (no sidecar)", async () => {
    const stale = join(root, "stale");
    const fresh = join(root, "fresh");
    const link = join(root, "link");
    await writeFile(stale, "old target");
    await writeFile(fresh, "new target");

    // Pre-existing arc symlink pointing at the stale target.
    await createSymlink(stale, link);
    // Re-point it (the cutover case: ~/bin symlink → ~/.local/bin).
    await createSymlink(fresh, link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(fresh);
    // A symlink is replaced, never backed up — no sidecar is left behind.
    expect(existsSync(link + ".pre-arc")).toBe(false);
  });

  // wave-3 hardening: a SECOND occupied-destination event must not clobber the
  // FIRST operator file already preserved at `<dest>.pre-arc`. The new backup
  // lands at a timestamped `<dest>.pre-arc.<epoch>` sidecar.
  test("arc#293: a second occupying file does not clobber the first .pre-arc backup", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "package data");

    // First conflict: operator file #1 → `.pre-arc`.
    await writeFile(link, "operator data ONE");
    await createSymlink(target, link);
    expect(await Bun.file(link + ".pre-arc").text()).toBe("operator data ONE");

    // Remove the arc symlink and drop a SECOND operator file at the same path.
    await unlink(link);
    await writeFile(link, "operator data TWO");
    await createSymlink(target, link);

    // The original backup is intact — never overwritten.
    expect(await Bun.file(link + ".pre-arc").text()).toBe("operator data ONE");

    // The second file was preserved at a distinct, timestamped sidecar.
    const extras = (await readdir(root)).filter(
      (n) => n.startsWith("link.pre-arc.") && n !== "link.pre-arc",
    );
    expect(extras.length).toBe(1);
    expect(await Bun.file(join(root, extras[0])).text()).toBe("operator data TWO");
    // And the link itself is the arc symlink.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
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
    // instead of the repo root. The value is captured with `pwd` command
    // substitution; `${VAR:-$(pwd)}` keeps an outer value when one arc CLI
    // shells out to another.
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
