import { describe, test, expect } from "bun:test";
import {
  binDir,
  configDir,
  dataDir,
  stateDir,
  cacheDir,
  isDirOnPath,
} from "../../src/lib/xdg-paths.js";
import { join } from "path";

const HOME = "/Users/tester";

describe("configDir / dataDir / stateDir / cacheDir — suite namespacing", () => {
  test("configDir falls back to ~/.config/metafactory/<app> when $XDG_CONFIG_HOME is unset", () => {
    expect(configDir("arc", { home: HOME, env: {} })).toBe(
      join(HOME, ".config", "metafactory", "arc"),
    );
  });

  test("dataDir falls back to ~/.local/share/metafactory/<app> when $XDG_DATA_HOME is unset", () => {
    expect(dataDir("arc", { home: HOME, env: {} })).toBe(
      join(HOME, ".local", "share", "metafactory", "arc"),
    );
  });

  test("stateDir falls back to ~/.local/state/metafactory/<app> when $XDG_STATE_HOME is unset", () => {
    expect(stateDir("arc", { home: HOME, env: {} })).toBe(
      join(HOME, ".local", "state", "metafactory", "arc"),
    );
  });

  test("cacheDir falls back to ~/.cache/metafactory/<app> when $XDG_CACHE_HOME is unset (XDG spec: cache is the ~/.local/* exception)", () => {
    expect(cacheDir("arc", { home: HOME, env: {} })).toBe(
      join(HOME, ".cache", "metafactory", "arc"),
    );
  });

  test("each dir is namespaced per-app — different apps never collide", () => {
    expect(configDir("arc", { home: HOME, env: {} })).toBe(
      join(HOME, ".config", "metafactory", "arc"),
    );
    expect(configDir("cortex", { home: HOME, env: {} })).toBe(
      join(HOME, ".config", "metafactory", "cortex"),
    );
  });
});

describe("$XDG_* env var matrix — each function honors its own var, ignores the others", () => {
  const cases: {
    fn: (app: string, seam?: Parameters<typeof configDir>[1]) => string;
    envVar: string;
    label: string;
  }[] = [
    { fn: configDir, envVar: "XDG_CONFIG_HOME", label: "configDir" },
    { fn: dataDir, envVar: "XDG_DATA_HOME", label: "dataDir" },
    { fn: stateDir, envVar: "XDG_STATE_HOME", label: "stateDir" },
    { fn: cacheDir, envVar: "XDG_CACHE_HOME", label: "cacheDir" },
  ];

  for (const { fn, envVar, label } of cases) {
    test(`${label}: set → uses $${envVar}/metafactory/<app>`, () => {
      const custom = "/custom/xdg-base";
      const dir = fn("arc", { home: HOME, env: { [envVar]: custom } });
      expect(dir).toBe(join(custom, "metafactory", "arc"));
    });

    test(`${label}: unset → falls back to spec default`, () => {
      const dir = fn("arc", { home: HOME, env: {} });
      expect(dir.startsWith(HOME)).toBe(true);
      expect(dir.endsWith(join("metafactory", "arc"))).toBe(true);
    });

    test(`${label}: empty-string env var is treated as unset`, () => {
      const dir = fn("arc", { home: HOME, env: { [envVar]: "   " } });
      expect(dir.startsWith(HOME)).toBe(true);
    });

    test(`${label}: other apps' $XDG_* vars are ignored`, () => {
      const others = cases
        .filter((c) => c.envVar !== envVar)
        .reduce<Record<string, string>>((acc, c) => {
          acc[c.envVar] = "/should-not-be-used";
          return acc;
        }, {});
      const dir = fn("arc", { home: HOME, env: others });
      expect(dir.startsWith("/should-not-be-used")).toBe(false);
    });

    test(`${label}: expands a ~-prefixed $${envVar}`, () => {
      const dir = fn("arc", { home: HOME, env: { [envVar]: "~/xdg-custom" } });
      expect(dir).toBe(join(HOME, "xdg-custom", "metafactory", "arc"));
    });
  }
});

describe("precedence — override > $XDG_* > fallback", () => {
  test("override wins even when the matching $XDG_* var is also set", () => {
    const dir = configDir("arc", {
      home: HOME,
      env: { XDG_CONFIG_HOME: "/from-env" },
      override: "/from-override",
    });
    expect(dir).toBe("/from-override");
  });

  test("override is returned verbatim — no metafactory/<app> suffix appended", () => {
    const dir = dataDir("arc", { home: HOME, env: {}, override: "/exact/path" });
    expect(dir).toBe("/exact/path");
  });

  test("override expands a leading ~", () => {
    const dir = stateDir("arc", { home: HOME, env: {}, override: "~/custom-state" });
    expect(dir).toBe(join(HOME, "custom-state"));
  });

  test("blank override falls through to $XDG_* (not treated as a real override)", () => {
    const dir = cacheDir("arc", {
      home: HOME,
      env: { XDG_CACHE_HOME: "/from-env" },
      override: "   ",
    });
    expect(dir).toBe(join("/from-env", "metafactory", "arc"));
  });

  test("with no override and no env var, falls back to spec default", () => {
    const dir = configDir("arc", { home: HOME, env: {} });
    expect(dir).toBe(join(HOME, ".config", "metafactory", "arc"));
  });
});

describe("binDir", () => {
  test("prefers ~/.local/bin when it is already on PATH", () => {
    const dir = binDir({
      home: HOME,
      env: { PATH: `${HOME}/bin:${HOME}/.local/bin:/usr/bin` },
    });
    expect(dir).toBe(`${HOME}/.local/bin`);
  });

  test("falls back to the second candidate ~/bin when only ~/bin is on PATH", () => {
    const dir = binDir({
      home: HOME,
      env: { PATH: `${HOME}/bin:/usr/bin` },
    });
    expect(dir).toBe(`${HOME}/bin`);
  });

  test("matches PATH entries with trailing slashes", () => {
    const dir = binDir({ home: HOME, env: { PATH: `${HOME}/.local/bin/:/usr/bin` } });
    expect(dir).toBe(`${HOME}/.local/bin`);
  });

  test("falls back to ~/.local/bin instead of creating ~/bin", () => {
    const dir = binDir({ home: HOME, env: { PATH: "/usr/bin:/bin" } });
    expect(dir).toBe(`${HOME}/.local/bin`);
  });

  test("falls back to ~/.local/bin when $PATH is unset", () => {
    const dir = binDir({ home: HOME, env: {} });
    expect(dir).toBe(`${HOME}/.local/bin`);
  });

  test("override takes precedence over PATH scanning", () => {
    const dir = binDir({
      home: HOME,
      env: { PATH: "/usr/bin:/bin" },
      override: "~/.arc/bin",
    });
    expect(dir).toBe(join(HOME, ".arc", "bin"));
  });

  test("honors the injected platform (win32 splits PATH on ';')", () => {
    // Host-independent: build the matching entry with the same `join` the
    // function uses, so it matches whether the host renders it with `/` or `\`.
    const localBin = join(HOME, ".local", "bin");
    const dir = binDir({
      home: HOME,
      env: { PATH: ["/usr/bin", localBin, "/opt/bin"].join(";") },
      platform: "win32",
    });
    expect(dir).toBe(localBin);
  });
});

/**
 * isDirOnPath mirrors paths.ts's function of the same name/signature —
 * these cases prove the win32 behavior (case-insensitive, separator-
 * agnostic, ';'-delimited) is preserved in the vendorable copy.
 */
describe("isDirOnPath — Windows branch smoke", () => {
  test("win32: finds the dir on a ';'-delimited PATH despite drive-letter colons", () => {
    expect(
      isDirOnPath(
        "C:\\Users\\k\\.local\\bin",
        "C:\\Windows;C:\\Users\\k\\.local\\bin;C:\\Program Files\\bin",
        "win32",
        "C:\\Users\\k",
      ),
    ).toBe(true);
  });

  test("win32: a posix ':' split mangles drive letters and misses the dir", () => {
    expect(
      isDirOnPath(
        "C:\\Users\\k\\.local\\bin",
        "C:\\Windows;C:\\Users\\k\\.local\\bin",
        "linux",
        "C:\\Users\\k",
      ),
    ).toBe(false);
  });

  test("win32: matches case-insensitively", () => {
    expect(
      isDirOnPath(
        "C:\\Users\\K\\.LOCAL\\Bin",
        "C:\\Windows;c:\\users\\k\\.local\\bin",
        "win32",
        "C:\\Users\\k",
      ),
    ).toBe(true);
  });

  test("win32: matches across separator spellings ('/' vs '\\', trailing '\\')", () => {
    expect(
      isDirOnPath(
        "C:/Users/k/.local/bin",
        "C:\\Windows;C:\\Users\\k\\.local\\bin\\",
        "win32",
        "C:\\Users\\k",
      ),
    ).toBe(true);
  });

  test("posix: stays case-sensitive", () => {
    expect(
      isDirOnPath("/Users/K/.local/bin", "/users/k/.local/bin:/usr/bin", "linux", "/Users/k"),
    ).toBe(false);
  });

  test("posix: finds the dir on a ':'-delimited PATH", () => {
    expect(
      isDirOnPath("/Users/k/.local/bin", "/usr/bin:/Users/k/.local/bin:/bin", "linux", "/Users/k"),
    ).toBe(true);
  });
});
