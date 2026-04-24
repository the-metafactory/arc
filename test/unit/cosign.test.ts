import { describe, test, expect } from "bun:test";
import {
  detectPlatform,
  findCosignBinary,
  ensureCosignBinary,
  verifySigstoreBundle,
} from "../../src/lib/cosign.js";

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

  test("includes download URL", () => {
    const platform = detectPlatform();
    expect(platform.downloadUrl).toContain(platform.binaryName);
    expect(platform.downloadUrl).toContain("github.com/sigstore/cosign");
  });
});

describe("findCosignBinary", () => {
  test("returns string or null", () => {
    const result = findCosignBinary();
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

describe("ensureCosignBinary", () => {
  // First-run may download the binary (~100MB) from GitHub Releases; allow up
  // to 60s so the smoke test gate is not flaky on a fresh worktree / CI cache.
  test("returns path or error", async () => {
    // Suppress stderr from potential download messages
    const originalWrite = process.stderr.write;
    process.stderr.write = (() => true) as any;
    try {
      const result = await ensureCosignBinary();
      expect(result.path !== undefined || result.error !== undefined).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  }, 60_000);
});

describe("verifySigstoreBundle", () => {
  // Cosign verify-blob attempts network lookups (Rekor, Fulcio) before
  // reporting the missing blob, so the negative-path case can take >5s on a
  // slow network. Extend the timeout so the smoke test gate is stable.
  test("returns invalid for nonexistent artifact and bundle", async () => {
    // Suppress stderr from potential download messages
    const originalWrite = process.stderr.write;
    process.stderr.write = (() => true) as any;
    try {
      const result = await verifySigstoreBundle(
        "/nonexistent/artifact.tar.gz",
        "/nonexistent/bundle.sigstore.json",
        "https://github.com/the-metafactory/meta-factory/.github/workflows/sign.yml@refs/heads/main",
        "https://token.actions.githubusercontent.com",
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    } finally {
      process.stderr.write = originalWrite;
    }
  }, 60_000);
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
