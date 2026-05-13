/**
 * Tests for arc#140 P3 launchd install: plist rendering + binary install +
 * rollback.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  installLaunchdArtifacts,
  rollbackLaunchdArtifacts,
  renderPlist,
  buildLaunchdTokens,
} from "../../src/lib/hosts/launchd-install.js";
import { createDarwinLaunchdHost } from "../../src/lib/hosts/darwin-launchd.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;
let plistDir: string;
let binDir: string;
let installDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-launchd-install-test-"));
  plistDir = join(tempDir, "LaunchAgents");
  binDir = join(tempDir, "bin");
  installDir = join(tempDir, "install");
  await mkdir(plistDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function fakeAgentManifest(overrides: Partial<ArcManifest> = {}): ArcManifest {
  return {
    name: "fake-bot",
    version: "0.1.0",
    type: "agent",
    ...overrides,
  };
}

describe("renderPlist", () => {
  test("substitutes known tokens", () => {
    const tpl = `<key>NATS</key><string>{{NATS_URL}}</string><key>Bin</key><string>{{BIN}}</string>`;
    const out = renderPlist(tpl, { NATS_URL: "nats://x:4222", BIN: "/Users/x/bin/foo" });
    expect(out).toContain("nats://x:4222");
    expect(out).toContain("/Users/x/bin/foo");
    expect(out).not.toContain("{{NATS_URL}}");
  });

  test("preserves unknown tokens verbatim", () => {
    const out = renderPlist("X={{NATS_URL}} Y={{CUSTOM}}", { NATS_URL: "nats://x" });
    expect(out).toBe("X=nats://x Y={{CUSTOM}}");
  });

  test("handles repeated tokens", () => {
    const out = renderPlist("{{X}} and {{X}}", { X: "ok" });
    expect(out).toBe("ok and ok");
  });
});

describe("buildLaunchdTokens", () => {
  test("provides BIN/INSTALL_PATH/HOME/LOG_DIR/NATS_URL defaults", () => {
    const tokens = buildLaunchdTokens({
      installPath: "/tmp/install",
      packageName: "sage",
    });
    expect(tokens.INSTALL_PATH).toBe("/tmp/install");
    expect(tokens.LOG_DIR).toContain("Library/Logs/sage");
    expect(tokens.NATS_URL).toBeDefined();
  });

  test("extra overrides win over defaults", () => {
    const tokens = buildLaunchdTokens({
      installPath: "/tmp/install",
      packageName: "sage",
      extra: { NATS_URL: "nats://override:4222", CUSTOM: "hi" },
    });
    expect(tokens.NATS_URL).toBe("nats://override:4222");
    expect(tokens.CUSTOM).toBe("hi");
  });
});

describe("installLaunchdArtifacts", () => {
  test("symlinks provides.binary into host.binDir", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\necho hello\n");
    await chmod(binSrc, 0o755);

    const host = createDarwinLaunchdHost({ plistDir, binDir, forcePlatform: "darwin" });
    const rec = await installLaunchdArtifacts({
      host,
      manifest: fakeAgentManifest({ provides: { binary: "bin/fake-bot" } }),
      installDir,
      quiet: true,
    });

    const expectedLink = join(binDir, "fake-bot");
    expect(rec.binSymlink).toBe(expectedLink);
    expect(existsSync(expectedLink)).toBe(true);
    expect(rec.plistPath).toBeUndefined();
  });

  test("renders provides.plist into plistDir with token substitution", async () => {
    const plistSrc = join(installDir, "services", "ai.fake.plist");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(
      plistSrc,
      `<plist><dict><key>Label</key><string>{{INSTALL_PATH}}/{{NATS_URL}}</string></dict></plist>`,
    );

    const host = createDarwinLaunchdHost({ plistDir, binDir, forcePlatform: "darwin" });
    const rec = await installLaunchdArtifacts({
      host,
      manifest: fakeAgentManifest({ provides: { plist: "services/ai.fake.plist" } }),
      installDir,
      quiet: true,
      tokens: { NATS_URL: "nats://test:4222" },
    });

    const expectedPlist = join(plistDir, "ai.fake.plist");
    expect(rec.plistPath).toBe(expectedPlist);
    const rendered = await readFile(expectedPlist, "utf-8");
    expect(rendered).toContain(installDir);
    expect(rendered).toContain("nats://test:4222");
    expect(rendered).not.toContain("{{INSTALL_PATH}}");
  });

  test("installs both binary and plist together with BIN token resolving to the symlink", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);

    const plistSrc = join(installDir, "services", "ai.fake.plist");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(plistSrc, `<plist>BIN={{BIN}}</plist>`);

    const host = createDarwinLaunchdHost({ plistDir, binDir, forcePlatform: "darwin" });
    const rec = await installLaunchdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", plist: "services/ai.fake.plist" },
      }),
      installDir,
      quiet: true,
    });

    const rendered = await readFile(rec.plistPath!, "utf-8");
    expect(rendered).toContain(`BIN=${join(binDir, "fake-bot")}`);
  });

  test("throws when provides.binary points at a missing file", async () => {
    const host = createDarwinLaunchdHost({ plistDir, binDir, forcePlatform: "darwin" });
    await expect(
      installLaunchdArtifacts({
        host,
        manifest: fakeAgentManifest({ provides: { binary: "bin/missing-bot" } }),
        installDir,
        quiet: true,
      }),
    ).rejects.toThrow(/provides\.binary 'bin\/missing-bot' does not exist/);
  });

  test("throws when provides.plist points at a missing file", async () => {
    const host = createDarwinLaunchdHost({ plistDir, binDir, forcePlatform: "darwin" });
    await expect(
      installLaunchdArtifacts({
        host,
        manifest: fakeAgentManifest({ provides: { plist: "services/missing.plist" } }),
        installDir,
        quiet: true,
      }),
    ).rejects.toThrow(/provides\.plist 'services\/missing\.plist' does not exist/);
  });
});

describe("rollbackLaunchdArtifacts", () => {
  test("removes both binary symlink and plist file", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "");
    await chmod(binSrc, 0o755);
    const plistSrc = join(installDir, "ai.fake.plist");
    await writeFile(plistSrc, `<plist></plist>`);

    const host = createDarwinLaunchdHost({ plistDir, binDir, forcePlatform: "darwin" });
    const rec = await installLaunchdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", plist: "ai.fake.plist" },
      }),
      installDir,
      quiet: true,
    });

    expect(existsSync(rec.binSymlink!)).toBe(true);
    expect(existsSync(rec.plistPath!)).toBe(true);

    await rollbackLaunchdArtifacts(rec);

    expect(existsSync(rec.binSymlink!)).toBe(false);
    expect(existsSync(rec.plistPath!)).toBe(false);
  });

  test("rollback is idempotent (second call is no-op)", async () => {
    const rec = { binSymlink: join(binDir, "never-existed") };
    await rollbackLaunchdArtifacts(rec);
    await rollbackLaunchdArtifacts(rec);
    // No throw is the assertion.
    expect(true).toBe(true);
  });
});
