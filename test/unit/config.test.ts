import { describe, expect, test } from "bun:test";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadUserConfig,
  normalizeUserPath,
  saveUserConfig,
} from "../../src/lib/config.js";

describe("user config", () => {
  test("saveUserConfig and loadUserConfig round-trip binDir", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "arc-user-config-"));

    await saveUserConfig(configRoot, { binDir: `${configRoot}/bin/` });
    const config = await loadUserConfig(configRoot);

    expect(config.binDir).toBe(`${configRoot}/bin`);
  });

  test("normalizeUserPath expands home and strips trailing slashes", () => {
    expect(normalizeUserPath("~/.local/bin///", "/Users/tester")).toBe(
      "/Users/tester/.local/bin",
    );
  });
});
