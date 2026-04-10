import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { join } from "path";
import { writeFile } from "fs/promises";
import {
  parsePackageRef,
  formatPackageRef,
  verifyChecksum,
  extractPackage,
} from "../../src/lib/registry-install.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// parsePackageRef tests
// ---------------------------------------------------------------------------

describe("parsePackageRef", () => {
  test("parses @scope/name", () => {
    const ref = parsePackageRef("@metafactory/grove");
    expect(ref).toEqual({ scope: "metafactory", name: "grove", version: undefined });
  });

  test("parses @scope/name@version", () => {
    const ref = parsePackageRef("@metafactory/grove@1.2.3");
    expect(ref).toEqual({ scope: "metafactory", name: "grove", version: "1.2.3" });
  });

  test("parses scope/name without @", () => {
    const ref = parsePackageRef("metafactory/grove");
    expect(ref).toEqual({ scope: "metafactory", name: "grove", version: undefined });
  });

  test("returns null for git URLs", () => {
    expect(parsePackageRef("https://github.com/org/repo")).toBeNull();
    expect(parsePackageRef("git@github.com:org/repo")).toBeNull();
    expect(parsePackageRef("http://example.com/repo")).toBeNull();
  });

  test("returns null for local paths", () => {
    expect(parsePackageRef("./local/path")).toBeNull();
    expect(parsePackageRef("/absolute/path")).toBeNull();
    expect(parsePackageRef("~/home/path")).toBeNull();
  });

  test("returns null for simple names without scope", () => {
    expect(parsePackageRef("grove")).toBeNull();
    expect(parsePackageRef("my-skill")).toBeNull();
  });
});

describe("formatPackageRef", () => {
  test("formats without version", () => {
    expect(formatPackageRef({ scope: "mf", name: "grove" })).toBe("@mf/grove");
  });

  test("formats with version", () => {
    expect(formatPackageRef({ scope: "mf", name: "grove", version: "1.0.0" })).toBe("@mf/grove@1.0.0");
  });
});

// ---------------------------------------------------------------------------
// verifyChecksum tests
// ---------------------------------------------------------------------------

describe("verifyChecksum", () => {
  test("returns valid for matching hash", async () => {
    const content = "test package content";
    const filePath = join(env.paths.reposDir, "test-verify.bin");
    await writeFile(filePath, content);

    // Compute expected hash
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const expectedHash = hasher.digest("hex");

    const result = await verifyChecksum(filePath, expectedHash);
    expect(result.valid).toBe(true);
    expect(result.actual).toBe(expectedHash);
    expect(result.expected).toBe(expectedHash);
  });

  test("returns invalid for mismatched hash", async () => {
    const filePath = join(env.paths.reposDir, "test-bad.bin");
    await writeFile(filePath, "actual content");

    const result = await verifyChecksum(filePath, "0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.valid).toBe(false);
    expect(result.expected).toBe("0000000000000000000000000000000000000000000000000000000000000000");
    expect(result.actual).not.toBe(result.expected);
  });

  test("handles case-insensitive comparison", async () => {
    const content = "case test";
    const filePath = join(env.paths.reposDir, "test-case.bin");
    await writeFile(filePath, content);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    const hash = hasher.digest("hex");

    const result = await verifyChecksum(filePath, hash.toUpperCase());
    expect(result.valid).toBe(true);
  });

  test("empty file has deterministic hash", async () => {
    const filePath = join(env.paths.reposDir, "test-empty.bin");
    await writeFile(filePath, "");

    const result = await verifyChecksum(filePath, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractPackage tests
// ---------------------------------------------------------------------------

describe("extractPackage", () => {
  test("fails on invalid tarball", async () => {
    const badTarball = join(env.paths.reposDir, "bad.tar.gz");
    await writeFile(badTarball, "this is not a tarball");

    const result = await extractPackage(badTarball, env.paths.reposDir, "test-pkg");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Extraction failed");
  });
});
