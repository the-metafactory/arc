/**
 * Tests for arc#311 (L2) linux-systemd install: unit rendering + binary
 * install + `systemctl` dispatch + rollback. Sister to
 * test/unit/launchd-install.test.ts.
 *
 * RENDER-ONLY design (principal decision, PR #314 review): install lands
 * `provides.binary` (symlink), `provides.systemdUnit` (rendered), then
 * `systemctl --user daemon-reload` — nothing more. Activation
 * (`enable --now`) is the package's own `lifecycle.postinstall` concern,
 * exactly matching how `launchd-install.ts` defers `launchctl bootstrap`.
 * Remove is UNCHANGED: `disable --now` (in case postinstall enabled it),
 * unlink unit, `daemon-reload`, unlink symlink — arc still owns teardown
 * symmetrically.
 *
 * NEVER spawns a real `systemctl` process — every test injects a recorder
 * (`SystemctlRunner`). The real-systemctl path is exercised only by
 * test/e2e/systemd-install.test.ts, gated to the CI systemd-e2e job.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  installSystemdArtifacts,
  removeSystemdArtifacts,
  rollbackSystemdArtifacts,
  renderUnit,
  buildSystemdTokens,
  withSpawnTimeout,
  type SystemctlRunner,
  type SystemctlResult,
} from "../../src/lib/hosts/systemd-install.js";
import { createLinuxSystemdHost } from "../../src/lib/hosts/linux-systemd.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;
let unitDir: string;
let binDir: string;
let installDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-systemd-install-test-"));
  unitDir = join(tempDir, "systemd", "user");
  binDir = join(tempDir, "bin");
  installDir = join(tempDir, "install");
  await mkdir(unitDir, { recursive: true });
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

/** Records every `systemctl --user <args>` call; args-keyed canned responses. */
function makeRecorder(responses: Record<string, SystemctlResult> = {}) {
  const calls: string[][] = [];
  const runner: SystemctlRunner = async (args) => {
    calls.push(args);
    return responses[args.join(" ")] ?? { code: 0, stderr: "" };
  };
  return { runner, calls };
}

/**
 * A runner that THROWS instead of resolving — this is what `Bun.spawn`
 * actually does synchronously on a missing binary (ENOENT), which the
 * PR #314 adversarial review proved the original recorder-only test suite
 * never exercised. `onlyFor` scopes the throw to a specific arg-tuple so
 * later steps in the same test can still be asserted as "never reached";
 * omit it to throw on every call.
 */
function makeThrowingRunner(message: string, onlyFor?: string[]): {
  runner: SystemctlRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: SystemctlRunner = async (args) => {
    calls.push(args);
    if (!onlyFor || args.join(" ") === onlyFor.join(" ")) {
      throw new Error(message);
    }
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

describe("renderUnit", () => {
  test("substitutes known tokens", () => {
    const tpl = `ExecStart={{BIN}}\nDescription={{INSTALL_PATH}}`;
    const out = renderUnit(tpl, { BIN: "/home/x/.local/bin/foo", INSTALL_PATH: "/opt/foo" });
    expect(out).toContain("/home/x/.local/bin/foo");
    expect(out).toContain("/opt/foo");
    expect(out).not.toContain("{{BIN}}");
  });

  test("preserves unknown tokens verbatim", () => {
    const out = renderUnit("X={{NATS_URL}} Y={{CUSTOM}}", { NATS_URL: "nats://x" });
    expect(out).toBe("X=nats://x Y={{CUSTOM}}");
  });

  test("handles repeated + hyphenated tokens", () => {
    const out = renderUnit("{{LOG-DIR}} and {{LOG-DIR}}", { "LOG-DIR": "/var/log/x" });
    expect(out).toBe("/var/log/x and /var/log/x");
  });
});

describe("buildSystemdTokens", () => {
  test("provides BIN/INSTALL_PATH/HOME/LOG_DIR/UNIT_DIR/NATS_URL defaults", () => {
    const tokens = buildSystemdTokens({
      installPath: "/tmp/install",
      packageName: "sage",
      unitDir,
    });
    expect(tokens.INSTALL_PATH).toBe("/tmp/install");
    expect(tokens.LOG_DIR).toContain("sage");
    expect(tokens.LOG_DIR).toContain("state");
    expect(tokens.UNIT_DIR).toBe(unitDir);
    expect(tokens.NATS_URL).toBeDefined();
  });

  test("extra overrides win over defaults", () => {
    const tokens = buildSystemdTokens({
      installPath: "/tmp/install",
      packageName: "sage",
      unitDir,
      extra: { NATS_URL: "nats://override:4222", CUSTOM: "hi" },
    });
    expect(tokens.NATS_URL).toBe("nats://override:4222");
    expect(tokens.CUSTOM).toBe("hi");
  });
});

describe("installSystemdArtifacts", () => {
  test("symlinks provides.binary into host.binDir (no unit declared, no systemctl calls)", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\necho hello\n");
    await chmod(binSrc, 0o755);

    const { runner, calls } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const rec = await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({ provides: { binary: "bin/fake-bot" } }),
      installDir,
      quiet: true,
      systemctlRunner: runner,
    });

    const expectedLink = join(binDir, "fake-bot");
    expect(rec.binSymlink).toBe(expectedLink);
    expect(existsSync(expectedLink)).toBe(true);
    expect(rec.unitPath).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("renders the unit then daemon-reloads — no enable, no linger check (activation deferred to lifecycle.postinstall)", async () => {
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(
      unitSrc,
      `[Service]\nExecStart={{BIN}}\n# nats={{NATS_URL}}\n`,
    );

    const { runner, calls } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const rec = await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({ provides: { systemdUnit: "services/fake-bot.service" } }),
      installDir,
      quiet: true,
      tokens: { NATS_URL: "nats://test:4222" },
      systemctlRunner: runner,
    });

    const expectedUnit = join(unitDir, "fake-bot.service");
    expect(rec.unitPath).toBe(expectedUnit);
    expect(rec.unitName).toBe("fake-bot.service");
    const rendered = await readFile(expectedUnit, "utf-8");
    expect(rendered).toContain("nats://test:4222");
    expect(rendered).not.toContain("{{NATS_URL}}");

    // ONLY daemon-reload -- no enable, no disable, no linger check.
    expect(calls).toEqual([["--user", "daemon-reload"]]);
  });

  test("BIN token resolves to the installed binary symlink", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);

    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart={{BIN}}\n`);

    const { runner } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const rec = await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
      }),
      installDir,
      quiet: true,
      systemctlRunner: runner,
    });

    const rendered = await readFile(rec.unitPath!, "utf-8");
    expect(rendered).toContain(`ExecStart=${join(binDir, "fake-bot")}`);
  });

  test("throws when provides.binary points at a missing file (no systemctl calls)", async () => {
    const { runner, calls } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    await expect(
      installSystemdArtifacts({
        host,
        manifest: fakeAgentManifest({ provides: { binary: "bin/missing-bot" } }),
        installDir,
        quiet: true,
        systemctlRunner: runner,
      }),
    ).rejects.toThrow(/provides\.binary 'bin\/missing-bot' does not exist/);
    expect(calls.length).toBe(0);
  });

  test("throws when provides.systemdUnit points at a missing file, cleans up the binary symlink first", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);

    const { runner } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    await expect(
      installSystemdArtifacts({
        host,
        manifest: fakeAgentManifest({
          provides: { binary: "bin/fake-bot", systemdUnit: "services/missing.service" },
        }),
        installDir,
        quiet: true,
        systemctlRunner: runner,
      }),
    ).rejects.toThrow(/provides\.systemdUnit 'services\/missing\.service' does not exist/);
    // The binary symlink landed before the throw — it must not leak.
    expect(existsSync(join(binDir, "fake-bot"))).toBe(false);
  });

  test("daemon-reload failure rolls back the rendered unit + binary symlink", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart={{BIN}}\n`);

    const { runner, calls } = makeRecorder({
      "--user daemon-reload": { code: 1, stderr: "Failed to reload daemon: bad unit syntax" },
    });
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });

    await expect(
      installSystemdArtifacts({
        host,
        manifest: fakeAgentManifest({
          provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
        }),
        installDir,
        quiet: true,
        systemctlRunner: runner,
      }),
    ).rejects.toThrow(/daemon-reload failed \(exit 1\): Failed to reload daemon: bad unit syntax/);

    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(false);
    expect(existsSync(join(binDir, "fake-bot"))).toBe(false);
    expect(calls).toEqual([["--user", "daemon-reload"]]);
  });
});

describe("removeSystemdArtifacts", () => {
  test("disables, unlinks the unit, reloads, then unlinks the binary symlink (in order)", async () => {
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart=/bin/true\n`);
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);

    const { runner: installRunner } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
      }),
      installDir,
      quiet: true,
      systemctlRunner: installRunner,
    });
    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(true);
    expect(existsSync(join(binDir, "fake-bot"))).toBe(true);

    // Remove still `disable --now`s unconditionally -- the package's own
    // postinstall may well have enabled it after this install landed the
    // render-only artifacts above.
    const { runner: removeRunner, calls } = makeRecorder();
    const removed = await removeSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
      }),
      quiet: true,
      systemctlRunner: removeRunner,
    });

    expect(removed.unitPath).toBe(join(unitDir, "fake-bot.service"));
    expect(removed.binSymlink).toBe(join(binDir, "fake-bot"));
    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(false);
    expect(existsSync(join(binDir, "fake-bot"))).toBe(false);
    expect(calls).toEqual([
      ["--user", "disable", "--now", "fake-bot.service"],
      ["--user", "daemon-reload"],
    ]);
  });

  test("remove is idempotent — a not-loaded disable is not warned as a failure and a second call is a no-op", async () => {
    const { runner, calls } = makeRecorder({
      "--user disable --now never-installed.service": {
        code: 1,
        stderr: "Failed to disable unit: Unit file never-installed.service does not exist.",
      },
    });
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const manifest = fakeAgentManifest({
      provides: { binary: "bin/never-installed", systemdUnit: "services/never-installed.service" },
    });

    const first = await removeSystemdArtifacts({ host, manifest, quiet: true, systemctlRunner: runner });
    const second = await removeSystemdArtifacts({ host, manifest, quiet: true, systemctlRunner: runner });

    // No throw is the primary assertion; both calls report nothing removed.
    expect(first.unitPath).toBeUndefined();
    expect(second.unitPath).toBeUndefined();
    expect(calls.length).toBe(4); // disable+reload, twice
  });
});

describe("rollbackSystemdArtifacts", () => {
  test("disables, removes the unit, reloads, then removes the binary symlink", async () => {
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart=/bin/true\n`);
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);

    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const { runner: installRunner } = makeRecorder();
    const rec = await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
      }),
      installDir,
      quiet: true,
      systemctlRunner: installRunner,
    });

    expect(existsSync(rec.unitPath!)).toBe(true);
    expect(existsSync(rec.binSymlink!)).toBe(true);

    const { runner: rollbackRunner, calls } = makeRecorder();
    await rollbackSystemdArtifacts(rec, { systemctlRunner: rollbackRunner });

    expect(existsSync(rec.unitPath!)).toBe(false);
    expect(existsSync(rec.binSymlink!)).toBe(false);
    expect(calls).toEqual([
      ["--user", "disable", "--now", "fake-bot.service"],
      ["--user", "daemon-reload"],
    ]);
  });

  test("rollback is idempotent (second call is a no-op, no throw)", async () => {
    const { runner } = makeRecorder();
    const rec = { binSymlink: join(binDir, "never-existed") };
    await rollbackSystemdArtifacts(rec, { systemctlRunner: runner });
    await rollbackSystemdArtifacts(rec, { systemctlRunner: runner });
    expect(true).toBe(true);
  });
});

/**
 * PR #314 adversarial review, BLOCKER: the original suite only ever
 * resolved `SystemctlRunner` with a `{code, stderr}` value — never THREW,
 * which is exactly what `Bun.spawn` does synchronously on a missing binary
 * (ENOENT). A throw used to bypass `cleanupPartial()` entirely and
 * propagate uncaught. `daemon-reload` is now the ONLY systemctl call
 * install makes (render-only design), so it's also the only throw surface
 * left to pin here.
 */
describe("installSystemdArtifacts — throwing runner (arc#311/PR#314 BLOCKER)", () => {
  test("a throwing systemctl call at daemon-reload cleans up the unit + symlink and throws a meaningful error", async () => {
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart={{BIN}}\n`);

    const { runner, calls } = makeThrowingRunner("spawn systemctl ENOENT");
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });

    await expect(
      installSystemdArtifacts({
        host,
        manifest: fakeAgentManifest({
          provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
        }),
        installDir,
        quiet: true,
        systemctlRunner: runner,
      }),
    ).rejects.toThrow(/daemon-reload failed \(exit -1\): spawn systemctl ENOENT/);

    // No leak: the rendered unit AND the binary symlink are both gone.
    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(false);
    expect(existsSync(join(binDir, "fake-bot"))).toBe(false);
    expect(calls).toEqual([["--user", "daemon-reload"]]);
  });
});

describe("removeSystemdArtifacts — throwing runner completes without crashing (arc#311/PR#314 BLOCKER)", () => {
  test("a throwing disable/daemon-reload still removes the unit file and binary symlink", async () => {
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart=/bin/true\n`);
    const binSrc = join(installDir, "bin", "fake-bot");
    await mkdir(join(installDir, "bin"), { recursive: true });
    await writeFile(binSrc, "#!/bin/bash\n");
    await chmod(binSrc, 0o755);

    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const { runner: installRunner } = makeRecorder();
    await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
      }),
      installDir,
      quiet: true,
      systemctlRunner: installRunner,
    });
    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(true);
    expect(existsSync(join(binDir, "fake-bot"))).toBe(true);

    const { runner: throwingRunner } = makeThrowingRunner("spawn systemctl ENOENT");
    // No throw is the primary assertion — a wedged/absent systemctl must not
    // crash `removeSystemdArtifacts`.
    const removed = await removeSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({
        provides: { binary: "bin/fake-bot", systemdUnit: "services/fake-bot.service" },
      }),
      quiet: true,
      systemctlRunner: throwingRunner,
    });

    expect(removed.unitPath).toBe(join(unitDir, "fake-bot.service"));
    expect(removed.binSymlink).toBe(join(binDir, "fake-bot"));
    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(false);
    expect(existsSync(join(binDir, "fake-bot"))).toBe(false);
  });
});

/**
 * PR #314 adversarial review, MINOR (a): a typo'd/unsupported token in
 * `provides.systemdUnit` must never reach disk — even render-only, a
 * broken unit file left for the package's postinstall to enable blind is
 * a needless landmine.
 */
describe("installSystemdArtifacts — unrendered-token gate (arc#311/PR#314 MINOR)", () => {
  test("a typo'd token aborts BEFORE the unit file is written and BEFORE any systemctl call", async () => {
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    // {{BINN}} is a typo for {{BIN}} -- not in the tokens map, so it survives
    // substitution verbatim.
    await writeFile(unitSrc, `[Service]\nExecStart={{BINN}}\n`);

    const { runner, calls } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });

    await expect(
      installSystemdArtifacts({
        host,
        manifest: fakeAgentManifest({ provides: { systemdUnit: "services/fake-bot.service" } }),
        installDir,
        quiet: true,
        systemctlRunner: runner,
      }),
    ).rejects.toThrow(/unrendered token\(s\).*\{\{BINN\}\}/s);

    expect(existsSync(join(unitDir, "fake-bot.service"))).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("a fully-resolved unit (no leftover tokens) installs normally", async () => {
    const unitSrc = join(installDir, "services", "fake-bot.service");
    await mkdir(join(installDir, "services"), { recursive: true });
    await writeFile(unitSrc, `[Service]\nExecStart=/bin/true\n`);

    const { runner } = makeRecorder();
    const host = createLinuxSystemdHost({ unitDir, binDir, forcePlatform: "linux" });
    const rec = await installSystemdArtifacts({
      host,
      manifest: fakeAgentManifest({ provides: { systemdUnit: "services/fake-bot.service" } }),
      installDir,
      quiet: true,
      systemctlRunner: runner,
    });

    expect(existsSync(rec.unitPath!)).toBe(true);
  });
});

/**
 * PR #314 adversarial review, MAJOR: the default runner/checker had no
 * timeout — a stuck D-Bus session would hang `arc install`/`arc remove`
 * forever (`proc.exited` and the pipe reads never resolve on a hung
 * process). `withSpawnTimeout` is the shared mechanism both defaults use;
 * exercised directly here with a short `ms` and a `kill`-spy stand-in
 * process object rather than a real 30s wait or a real spawned process.
 */
describe("withSpawnTimeout (arc#311/PR#314 MAJOR)", () => {
  test("a work promise that never resolves times out, kills the process, and throws", async () => {
    let killed = false;
    const fakeProc = { kill: () => { killed = true; } };
    const neverResolves = new Promise<{ code: number; stderr: string }>(() => {});

    await expect(
      withSpawnTimeout(fakeProc, neverResolves, "systemctl", 20),
    ).rejects.toThrow(/systemctl timed out after 0s/);
    expect(killed).toBe(true);
  });

  test("a work promise that resolves before the timeout wins the race, no kill", async () => {
    let killed = false;
    const fakeProc = { kill: () => { killed = true; } };
    const fastWork = Promise.resolve({ code: 0, stderr: "" });

    const result = await withSpawnTimeout(fakeProc, fastWork, "systemctl", 5_000);
    expect(result).toEqual({ code: 0, stderr: "" });
    expect(killed).toBe(false);
  });
});
