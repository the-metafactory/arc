import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, lstat, readlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSymlink, removeSymlink } from "../../src/lib/symlinks.js";

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
  test("arc#163: refuses to overwrite a regular file", async () => {
    const target = join(root, "real");
    const link = join(root, "link");
    await writeFile(target, "package data");
    await writeFile(link, "operator data");

    await expect(createSymlink(target, link)).rejects.toThrow(/regular file/);

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
