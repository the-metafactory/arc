/**
 * Tests for the linux-systemd HostAdapter (arc#140 P6).
 *
 * Adapter surface only — install/remove dispatch lands "once the first
 * Linux host enters the deployment topology" per cortex
 * `docs/design-arc-agent-bots.md` §11 Phase C.3.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  createLinuxSystemdHost,
  linuxSystemdPaths,
} from "../../src/lib/hosts/linux-systemd.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-systemd-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("linux-systemd HostAdapter", () => {
  test("id is 'linux-systemd'", () => {
    const host = createLinuxSystemdHost({ forcePlatform: "linux" });
    expect(host.id).toBe("linux-systemd");
  });

  test("default paths reference ~/.config/systemd/user and ~/bin", () => {
    const paths = linuxSystemdPaths();
    expect(paths.unitDir).toMatch(/\.config\/systemd\/user$/);
    expect(paths.binDir).toMatch(/\/bin$/);
    expect(paths.settingsPath).toBe(paths.unitDir);
    expect(paths.root).toBe(paths.unitDir);
  });

  test("non-host directories (skills/agents/prompts) are empty strings", () => {
    const paths = linuxSystemdPaths();
    expect(paths.skillsDir).toBe("");
    expect(paths.agentsDir).toBe("");
    expect(paths.promptsDir).toBe("");
  });

  test("paths can be overridden for test isolation", () => {
    const unitDir = join(tempDir, "systemd-user");
    const binDir = join(tempDir, "bin");
    const paths = linuxSystemdPaths({ unitDir, binDir });
    expect(paths.unitDir).toBe(unitDir);
    expect(paths.binDir).toBe(binDir);
  });

  test("detect() returns true on linux when unitDir exists", async () => {
    const unitDir = join(tempDir, "systemd-user");
    await mkdir(unitDir, { recursive: true });
    const host = createLinuxSystemdHost({
      unitDir, binDir: join(tempDir, "bin"), forcePlatform: "linux",
    });
    expect(host.detect()).toBe(true);
  });

  test("detect() returns false when unitDir does not exist", () => {
    const host = createLinuxSystemdHost({
      unitDir: join(tempDir, "missing"), binDir: join(tempDir, "bin"), forcePlatform: "linux",
    });
    expect(host.detect()).toBe(false);
  });

  test("detect() returns false on non-linux platforms even when unitDir exists", async () => {
    const unitDir = join(tempDir, "systemd-user");
    await mkdir(unitDir, { recursive: true });
    const host = createLinuxSystemdHost({
      unitDir, binDir: join(tempDir, "bin"), forcePlatform: "darwin",
    });
    expect(host.detect()).toBe(false);
  });

  test("supports() accepts agent and tool artifact types", () => {
    const host = createLinuxSystemdHost({ forcePlatform: "linux" });
    expect(host.supports("agent")).toBe(true);
    expect(host.supports("tool")).toBe(true);
  });

  test("supports() declines artifact types systemd does not host", () => {
    const host = createLinuxSystemdHost({ forcePlatform: "linux" });
    expect(host.supports("skill")).toBe(false);
    expect(host.supports("prompt")).toBe(false);
    expect(host.supports("component")).toBe(false);
  });
});
