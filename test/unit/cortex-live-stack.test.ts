import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { liveCortexStackDirs, resolveLiveCortexStackDir } from "../../src/lib/hosts/cortex-live-stack.js";
import { cortexPaths } from "../../src/lib/hosts/cortex.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "arc-live-stack-"));
  homes.push(h);
  return h;
}

function plist(h: string, label: string, args: string[]): void {
  const dir = join(h, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const strings = args.map((a) => `<string>${a}</string>`).join("");
  writeFileSync(
    join(dir, `${label}.plist`),
    `<?xml version="1.0"?><plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${strings}</array></dict></plist>`,
  );
}

describe("resolveLiveCortexStackDir (cortex#3134)", () => {
  test("a config-split daemon's stack dir is the default cortex host root, so agents.d lands where it reads", () => {
    const h = home();
    mkdirSync(join(h, ".config", "metafactory", "cortex"), { recursive: true });
    plist(h, "ai.meta-factory.cortex.default", [
      `${h}/.local/bin/cortex`,
      "start",
      "--config",
      `${h}/.config/cortex/default/default.yaml`,
    ]);

    const paths = cortexPaths({ seam: { home: h, env: {} } });

    expect(paths.agentsDir).toBe(join(h, ".config", "cortex", "default", "agents.d"));
    expect(paths.personasDir).toBe(join(h, ".config", "cortex", "default", "personas"));
  });

  test("with several stacks, the one named default wins; sibling cortex services without --config are ignored", () => {
    const h = home();
    plist(h, "ai.meta-factory.cortex.switch", ["cortex", "start", "--config", `${h}/.config/cortex/switch/switch.yaml`]);
    plist(h, "ai.meta-factory.cortex.default", ["cortex", "start", "--config", `${h}/.config/cortex/default/default.yaml`]);
    plist(h, "ai.meta-factory.cortex.relay", ["bun", `${h}/repos/cortex/src/taps/cc-events/relay.ts`, "start"]);

    expect(liveCortexStackDirs(h)).toEqual([join(h, ".config/cortex/default"), join(h, ".config/cortex/switch")]);
    expect(resolveLiveCortexStackDir({ home: h, env: {} })).toBe(join(h, ".config/cortex/default"));
  });

  test("several stacks and none named default: undefined, so the caller keeps the config-dir fallback", () => {
    const h = home();
    plist(h, "ai.meta-factory.cortex.work", ["cortex", "start", "--config", `${h}/.config/cortex/work/work.yaml`]);
    plist(h, "ai.meta-factory.cortex.home", ["cortex", "start", "--config", `${h}/.config/cortex/home/home.yaml`]);

    expect(resolveLiveCortexStackDir({ home: h, env: {} })).toBeUndefined();
  });

  test("a systemd user unit's ExecStart --config is discovered too", () => {
    const h = home();
    const unitDir = join(h, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "cortex@default.service"),
      `[Service]\nExecStart=-/usr/bin/cortex start --config ${h}/.config/cortex/default/default.yaml\n`,
    );

    expect(resolveLiveCortexStackDir({ home: h, env: {} })).toBe(join(h, ".config/cortex/default"));
  });

  test("$CORTEX_CONFIG_DIR is an explicit root, so discovery stays out of the way", () => {
    const h = home();
    plist(h, "ai.meta-factory.cortex.default", ["cortex", "start", "--config", `${h}/.config/cortex/default/default.yaml`]);

    expect(resolveLiveCortexStackDir({ home: h, env: { CORTEX_CONFIG_DIR: `${h}/explicit` } })).toBeUndefined();
  });

  test("no installed cortex service: undefined (a fresh host keeps today's default)", () => {
    expect(resolveLiveCortexStackDir({ home: home(), env: {} })).toBeUndefined();
  });
});
