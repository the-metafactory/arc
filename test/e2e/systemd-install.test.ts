/**
 * arc#311 (L2) e2e: linux-systemd RENDER-ONLY install/remove against a REAL
 * `systemd --user` session. This is the CI systemd-e2e job's glob target
 * (`test/e2e/systemd*.test.ts` — see .github/workflows/ci.yml); it runs
 * ONLY there.
 *
 * RENDER-ONLY design (principal decision, PR #314 review): install lands
 * the binary symlink + rendered unit + `daemon-reload` — nothing more.
 * Activation (`enable --now`) is the package's own `lifecycle.postinstall`
 * concern, so this test does NOT start anything and does NOT assert
 * `is-active`. It asserts that systemd actually SEES the rendered unit
 * (`systemctl --user cat <unit>` succeeds) after install, and no longer
 * does after remove.
 *
 * Deliberately does NOT override unitDir/binDir the way the command-level
 * multitarget tests (test/commands/install-multitarget-systemd-311.test.ts)
 * do: the already-running `systemd --user` manager resolves its unit search
 * path from ITS OWN startup environment, not from whatever env this test
 * process happens to set. An overridden HOME/unitDir here would render a
 * unit file the real manager can never see. So this test exercises the REAL
 * `~/.config/systemd/user` + shared bin dir, exactly as a genuine install
 * would on the ephemeral CI runner.
 *
 * Guarded by `RUN_E2E` — an EXPLICIT opt-in (`SYSTEMD_E2E=1`, set only by
 * the systemd-e2e job in ci.yml), AND'd with a bus/platform sanity check.
 * The explicit opt-in is load-bearing, not decorative: a plain
 * `ubuntu-latest` runner's default user session already has a working
 * XDG_RUNTIME_DIR + bus by default, so the bus/platform check ALONE can't
 * tell the systemd-e2e job apart from the ordinary `Test` job — this test
 * would otherwise run (and fail, no `~/.config/systemd/user`) in the
 * plain lane too. Mirrors cortex#2092's sibling job's same fix. Never runs
 * on macOS dev machines either way (`process.platform !== "linux"` alone
 * already excludes those). Mirrors the `test.skipIf(!NSC_AVAILABLE)` idiom
 * in test/commands/nats.test.ts.
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { mkdir, writeFile, chmod, rm } from "fs/promises";
import { join } from "path";
import { install } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { getSkill } from "../../src/lib/db.js";
import { linuxSystemdPaths } from "../../src/lib/hosts/linux-systemd.js";

function systemctlUser(args: string[]) {
  return Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
}

function canRunSystemdE2E(): boolean {
  // Explicit opt-in FIRST — see the doc comment above for why this is the
  // load-bearing check, not the bus/platform sanity checks that follow.
  if (process.env.SYSTEMD_E2E !== "1") return false;
  if (process.platform !== "linux") return false;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !existsSync(join(runtimeDir, "bus"))) return false;
  return systemctlUser(["show-environment"]).exitCode === 0;
}

const RUN_E2E = canRunSystemdE2E();
const UNIT_NAME = "arc-e2e-render.service";
const BIN_NAME = "arc-e2e-daemon";
const PKG_NAME = "arc-e2e-render";

describe("linux-systemd install/remove e2e (real systemctl --user, render-only)", () => {
  test.skipIf(!RUN_E2E)(
    "install renders + daemon-reloads (no enable/start); remove tears it all down (unit, service, symlink)",
    async () => {
      const env: TestEnv = await createTestEnv();
      const paths = linuxSystemdPaths();
      const unitPath = join(paths.unitDir, UNIT_NAME);
      const binPath = join(paths.binDir, BIN_NAME);

      try {
        const repoDir = join(env.root, "mock-e2e-render");
        await mkdir(join(repoDir, "bin"), { recursive: true });
        await writeFile(join(repoDir, "bin", BIN_NAME), `#!/bin/bash\nexec /bin/sleep infinity\n`);
        await chmod(join(repoDir, "bin", BIN_NAME), 0o755);

        await mkdir(join(repoDir, "services"), { recursive: true });
        await writeFile(
          join(repoDir, "services", UNIT_NAME),
          `[Unit]\nDescription=arc e2e render-only test unit\n\n[Service]\nExecStart={{BIN}}\n`,
        );

        await writeFile(
          join(repoDir, "arc-manifest.yaml"),
          `name: ${PKG_NAME}
version: 0.1.0
type: agent
tier: custom
targets: [linux-systemd]
identity:
  id: ${PKG_NAME}
  roles: [agent-restricted]
runtime:
  substrate: custom-binary
  mode: standalone
provides:
  binary: bin/${BIN_NAME}
  systemdUnit: services/${UNIT_NAME}
`,
        );
        Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        Bun.spawnSync(
          ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
          { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
        );

        const installResult = await install({
          arc: env.arc,
          host: env.host,
          db: env.db,
          repoUrl: repoDir,
          yes: true,
        });
        expect(installResult.success).toBe(true);

        expect(existsSync(unitPath)).toBe(true);
        expect(existsSync(binPath)).toBe(true);

        // Render-only: systemd SEES the unit (daemon-reload picked it up,
        // `cat` can locate + parse it) — but nothing started it. No
        // is-active assertion; arc never ran enable --now.
        const cat = systemctlUser(["cat", UNIT_NAME]);
        expect(cat.exitCode).toBe(0);
        expect(cat.stdout.toString()).toContain("arc e2e render-only test unit");

        const activeBeforeRemove = systemctlUser(["is-active", UNIT_NAME]);
        expect(activeBeforeRemove.stdout.toString().trim()).not.toBe("active");

        const removeResult = await remove(env.db, env.arc, env.host, PKG_NAME, { quiet: true });
        expect(removeResult.success).toBe(true);

        expect(existsSync(unitPath)).toBe(false);
        expect(existsSync(binPath)).toBe(false);
        const catAfterRemove = systemctlUser(["cat", UNIT_NAME]);
        expect(catAfterRemove.exitCode).not.toBe(0);
        expect(getSkill(env.db, PKG_NAME)).toBeNull();
      } finally {
        // Best-effort real-world cleanup regardless of assertion outcome —
        // this test touches the REAL ~/.config/systemd/user (see file
        // header). Nothing was ever enabled/started (render-only), but
        // `disable --now` is a harmless no-op if that's true and a safety
        // net if some prior failed run left something loaded.
        systemctlUser(["disable", "--now", UNIT_NAME]);
        await rm(unitPath, { force: true });
        await rm(binPath, { force: true });
        systemctlUser(["daemon-reload"]);
        await env.cleanup();
      }
    },
  );

  test("RUN_E2E guard reflects environment reality", () => {
    // No real assertion beyond "doesn't throw" — exists so the plain `Test`
    // CI job (no systemd user session) still reports ONE executed test from
    // this file rather than a suite of zero, matching the guidance to skip
    // cleanly instead of silently vanishing.
    expect(typeof RUN_E2E).toBe("boolean");
  });
});
