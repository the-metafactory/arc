/**
 * Tests for the darwin-launchd HostAdapter (arc#140 P2).
 *
 * Adapter surface only — install/remove dispatch lands in arc#140 P3.
 * Verifies:
 *   - id is "darwin-launchd"
 *   - paths build correctly from defaults and from overrides
 *   - detect() honors platform + plist directory presence
 *   - supports() recognizes agent + tool, declines skill/prompt/etc.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  createDarwinLaunchdHost,
  darwinLaunchdPaths,
} from "../../src/lib/hosts/darwin-launchd.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-launchd-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("darwin-launchd HostAdapter", () => {
  test("id is 'darwin-launchd'", () => {
    const host = createDarwinLaunchdHost({ forcePlatform: "darwin" });
    expect(host.id).toBe("darwin-launchd");
  });

  test("default paths reference ~/Library/LaunchAgents and ~/bin", () => {
    const paths = darwinLaunchdPaths();
    expect(paths.plistDir).toMatch(/Library\/LaunchAgents$/);
    expect(paths.binDir).toMatch(/\/bin$/);
    expect(paths.settingsPath).toBe(paths.plistDir);
    expect(paths.root).toBe(paths.plistDir);
  });

  test("non-host directories (skills/agents/prompts) are empty strings", () => {
    const paths = darwinLaunchdPaths();
    expect(paths.skillsDir).toBe("");
    expect(paths.agentsDir).toBe("");
    expect(paths.promptsDir).toBe("");
  });

  test("paths can be overridden for test isolation", () => {
    const plistDir = join(tempDir, "LaunchAgents");
    const binDir = join(tempDir, "bin");
    const paths = darwinLaunchdPaths({ plistDir, binDir });
    expect(paths.plistDir).toBe(plistDir);
    expect(paths.binDir).toBe(binDir);
    expect(paths.settingsPath).toBe(plistDir);
  });

  test("detect() returns true on darwin when plistDir exists", async () => {
    const plistDir = join(tempDir, "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    const host = createDarwinLaunchdHost({
      plistDir,
      binDir: join(tempDir, "bin"),
      forcePlatform: "darwin",
    });
    expect(host.detect()).toBe(true);
  });

  test("detect() returns false when plistDir does not exist", () => {
    const host = createDarwinLaunchdHost({
      plistDir: join(tempDir, "missing-LaunchAgents"),
      binDir: join(tempDir, "bin"),
      forcePlatform: "darwin",
    });
    expect(host.detect()).toBe(false);
  });

  test("detect() returns false on non-darwin platforms even when plistDir exists", async () => {
    const plistDir = join(tempDir, "LaunchAgents");
    await mkdir(plistDir, { recursive: true });
    const host = createDarwinLaunchdHost({
      plistDir,
      binDir: join(tempDir, "bin"),
      forcePlatform: "linux",
    });
    expect(host.detect()).toBe(false);
  });

  test("supports() accepts agent and tool artifact types", () => {
    const host = createDarwinLaunchdHost({ forcePlatform: "darwin" });
    expect(host.supports("agent")).toBe(true);
    expect(host.supports("tool")).toBe(true);
  });

  test("supports() declines artifact types launchd does not host", () => {
    const host = createDarwinLaunchdHost({ forcePlatform: "darwin" });
    expect(host.supports("skill")).toBe(false);
    expect(host.supports("prompt")).toBe(false);
    expect(host.supports("component")).toBe(false);
    expect(host.supports("rules")).toBe(false);
    expect(host.supports("library")).toBe(false);
    expect(host.supports("pipeline")).toBe(false);
    expect(host.supports("action")).toBe(false);
  });
});
