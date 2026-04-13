import { describe, test, expect } from "bun:test";
import { detectPlatform, findCosignBinary, verifySigstoreBundle } from "../../src/lib/cosign.js";

describe("detectPlatform", () => {
  test("returns valid platform info", () => {
    const platform = detectPlatform();
    expect(["darwin", "linux"]).toContain(platform.os);
    expect(["arm64", "amd64"]).toContain(platform.arch);
    expect(platform.binaryName).toMatch(/^cosign-(darwin|linux)-(arm64|amd64)$/);
  });

  test("binary name matches os-arch pattern", () => {
    const platform = detectPlatform();
    expect(platform.binaryName).toBe(`cosign-${platform.os}-${platform.arch}`);
  });
});

describe("findCosignBinary", () => {
  test("returns string or null", () => {
    const result = findCosignBinary();
    // Binary may or may not be present depending on whether fetch-cosign has run
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("returned path ends with platform binary name when found", () => {
    const result = findCosignBinary();
    if (result !== null) {
      const platform = detectPlatform();
      expect(result).toContain(platform.binaryName);
    }
  });
});

describe("verifySigstoreBundle", () => {
  test("returns invalid for nonexistent artifact and bundle", () => {
    const result = verifySigstoreBundle(
      "/nonexistent/artifact.tar.gz",
      "/nonexistent/bundle.sigstore.json",
      "https://github.com/the-metafactory/meta-factory/.github/workflows/sign.yml@refs/heads/main",
      "https://token.actions.githubusercontent.com",
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    // Either "binary not found" (no cosign) or cosign error (binary present, bad args)
    expect(typeof result.error).toBe("string");
  });
});

describe("detectPlatform - unsupported", () => {
  test("throws on unsupported platform", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(() => detectPlatform()).toThrow("Unsupported platform: win32");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });
});
