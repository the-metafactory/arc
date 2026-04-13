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
  test("returns error when cosign binary not found", () => {
    // Use a non-existent artifact — the point is to test the missing-binary path
    // This test works regardless of whether cosign is bundled, because even if
    // the binary exists, the artifact paths don't exist so it would fail differently
    const result = verifySigstoreBundle(
      "/nonexistent/artifact.tar.gz",
      "/nonexistent/bundle.sigstore.json",
      "https://github.com/the-metafactory/meta-factory/.github/workflows/sign.yml@refs/heads/main",
      "https://token.actions.githubusercontent.com",
    );
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
