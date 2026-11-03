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

function pointer(h: string, stack: string): string {
  const dir = join(h, ".config", "cortex", stack);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${stack}.yaml`);
  writeFileSync(p, "# pointer\n");
  return p;
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

function unit(h: string, name: string, execStart: string): void {
  const dir = join(h, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `[Service]\nExecStart=${execStart}\n`);
}

describe("resolveLiveCortexStackDir (cortex#3134)", () => {
  test("a config-split daemon's stack dir is the default cortex host root, so agents.d lands where it reads", () => {
    const h = home();
    mkdirSync(join(h, ".config", "metafactory", "cortex"), { recursive: true });
    plist(h, "ai.meta-factory.cortex.default", [`${h}/.local/bin/cortex`, "start", "--config", pointer(h, "default")]);

    const paths = cortexPaths({ seam: { home: h, env: {} } });

    expect(paths.agentsDir).toBe(join(h, ".config", "cortex", "default", "agents.d"));
    expect(paths.personasDir).toBe(join(h, ".config", "cortex", "default", "personas"));
  });

  test("with several stacks, the one named default wins; sibling cortex services without --config are ignored", () => {
    const h = home();
    plist(h, "ai.meta-factory.cortex.switch", ["cortex", "start", "--config", pointer(h, "switch")]);
    plist(h, "ai.meta-factory.cortex.default", ["cortex", "start", "--config", pointer(h, "default")]);
    plist(h, "ai.meta-factory.cortex.relay", ["bun", `${h}/repos/cortex/src/taps/cc-events/relay.ts`, "start"]);

    expect(liveCortexStackDirs(h)).toEqual([join(h, ".config/cortex/default"), join(h, ".config/cortex/switch")]);
    expect(resolveLiveCortexStackDir({ home: h, env: {} })).toBe(join(h, ".config/cortex/default"));
  });

  test("several stacks and none named default: undefined, so the caller keeps the config-dir fallback", () => {
    const h = home();
    plist(h, "ai.meta-factory.cortex.work", ["cortex", "start", "--config", pointer(h, "work")]);
    plist(h, "ai.meta-factory.cortex.home", ["cortex", "start", "--config", pointer(h, "home")]);

    expect(resolveLiveCortexStackDir({ home: h, env: {} })).toBeUndefined();
  });

  test("a systemd user unit's ExecStart --config is discovered, with %h expanded to the home dir", () => {
    const h = home();
    pointer(h, "default");
    unit(h, "cortex@default.service", "-/usr/bin/cortex start --config %h/.config/cortex/default/default.yaml");

    expect(resolveLiveCortexStackDir({ home: h, env: {} })).toBe(join(h, ".config/cortex/default"));
  });

  test("a relative --config, or one naming a file that no longer exists, is skipped", () => {
    const h = home();
    unit(h, "cortex@rel.service", "/usr/bin/cortex start --config cortex/rel/rel.yaml");
    plist(h, "ai.meta-factory.cortex.retired", ["cortex", "start", "--config", `${h}/.config/cortex/retired/retired.yaml`]);

    expect(liveCortexStackDirs(h)).toEqual([]);
  });

  test("$CORTEX_CONFIG_DIR is an explicit root, so discovery stays out of the way", () => {
    const h = home();
    plist(h, "ai.meta-factory.cortex.default", ["cortex", "start", "--config", pointer(h, "default")]);

    expect(resolveLiveCortexStackDir({ home: h, env: { CORTEX_CONFIG_DIR: `${h}/explicit` } })).toBeUndefined();
  });

  test("no installed cortex service: undefined (a fresh host keeps today's default)", () => {
    expect(resolveLiveCortexStackDir({ home: home(), env: {} })).toBeUndefined();
  });
});
