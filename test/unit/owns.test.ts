import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, symlink, lstat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateOwns,
  expandOwnsEntry,
  isUnderHome,
  deleteOwnedPath,
  hasOwns,
  purgeableEntries,
  userDataEntries,
} from "../../src/lib/owns.js";

let home: string;
let outside: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "owns-home-"));
  outside = await mkdtemp(join(tmpdir(), "owns-out-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("validateOwns — shape + safety", () => {
  test("accepts well-formed ~-rooted entries", () => {
    expect(
      validateOwns({
        config: ["~/.config/metafactory/cortex"],
        state: ["~/.local/state/metafactory/cortex/**"],
        userData: ["~/Developer/workspace"],
      }),
    ).toEqual([]);
  });

  test("accepts an absent declaration", () => {
    expect(validateOwns(undefined)).toEqual([]);
    expect(validateOwns(null)).toEqual([]);
  });

  test("rejects an absolute path", () => {
    const v = validateOwns({ config: ["/etc/passwd"] });
    expect(v.length).toBe(1);
    expect(v[0].rule).toContain("absolute");
  });

  test("rejects a bare '~' (whole-home sweep)", () => {
    const v = validateOwns({ state: ["~"] });
    expect(v.length).toBe(1);
    expect(v[0].rule).toContain("~/");
  });

  test("rejects '~/' with an empty tail", () => {
    const v = validateOwns({ state: ["~/"] });
    expect(v.length).toBe(1);
    expect(v[0].rule).toContain("empty tail");
  });

  test("rejects a bare '/'", () => {
    const v = validateOwns({ config: ["/"] });
    expect(v.length).toBe(1);
    expect(v[0].rule).toContain("absolute");
  });

  test("rejects a leading '*'/'**' segment (home-root sweep)", () => {
    expect(validateOwns({ config: ["~/*"] })[0].rule).toContain("sweep");
    expect(validateOwns({ config: ["~/**"] })[0].rule).toContain("sweep");
  });

  test("rejects a '..' segment", () => {
    const v = validateOwns({ config: ["~/.config/../.ssh"] });
    expect(v.some((x) => x.rule.includes(".."))).toBe(true);
  });

  test("rejects overlap between userData and config/state", () => {
    const v = validateOwns({
      config: ["~/.config/foo"],
      userData: ["~/.config/foo"],
    });
    expect(v.some((x) => x.field === "owns.userData")).toBe(true);
  });

  test("rejects unknown top-level keys", () => {
    const v = validateOwns({ nope: ["~/x"] });
    expect(v.some((x) => x.rule.includes("unexpected key"))).toBe(true);
  });

  test("rejects a non-array class and non-string entries", () => {
    expect(validateOwns({ config: "~/x" }).length).toBeGreaterThan(0);
    expect(validateOwns({ config: [123] }).length).toBeGreaterThan(0);
  });

  test("collects EVERY violation in one pass", () => {
    const v = validateOwns({ config: ["/abs", "~/ok", "~/*"] });
    // /abs (absolute) + ~/* (sweep) = 2 violations; ~/ok is clean.
    expect(v.length).toBe(2);
  });
});

describe("owns helpers", () => {
  test("hasOwns / purgeableEntries / userDataEntries", () => {
    const owns = { config: ["~/c"], state: ["~/s"], userData: ["~/u"] };
    expect(hasOwns(owns)).toBe(true);
    expect(hasOwns(undefined)).toBe(false);
    expect(hasOwns({ config: [] })).toBe(false);
    expect(purgeableEntries(owns)).toEqual(["~/c", "~/s"]);
    expect(userDataEntries(owns)).toEqual(["~/u"]);
  });
});

describe("expandOwnsEntry", () => {
  test("literal path returns a single candidate whether or not it exists", () => {
    expect(expandOwnsEntry("~/.config/foo", home)).toEqual([join(home, ".config/foo")]);
  });

  test("glob expands to matches under home only", async () => {
    await mkdir(join(home, ".config/metafactory/cortex/work"), { recursive: true });
    await writeFile(join(home, ".config/metafactory/cortex/system.yaml"), "x");
    const matches = expandOwnsEntry("~/.config/metafactory/cortex/**", home);
    expect(matches).toContain(join(home, ".config/metafactory/cortex/work"));
    expect(matches).toContain(join(home, ".config/metafactory/cortex/system.yaml"));
    for (const m of matches) expect(isUnderHome(m, home)).toBe(true);
  });

  test("glob with no match returns []", () => {
    expect(expandOwnsEntry("~/.config/nope/*", home)).toEqual([]);
  });
});

describe("isUnderHome", () => {
  test("true for a child, false for home itself and for escapes", () => {
    expect(isUnderHome(join(home, ".config"), home)).toBe(true);
    expect(isUnderHome(home, home)).toBe(false);
    expect(isUnderHome(outside, home)).toBe(false);
    expect(isUnderHome(join(home, "..", "x"), home)).toBe(false);
  });
});

describe("deleteOwnedPath — safety", () => {
  test("deletes a real dir under home", async () => {
    const target = join(home, ".config/metafactory/cortex");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "system.yaml"), "x");
    const out = await deleteOwnedPath(target, home);
    expect(out.status).toBe("deleted");
    expect(existsSync(target)).toBe(false);
  });

  test("absent path is a no-op", async () => {
    const out = await deleteOwnedPath(join(home, ".config/gone"), home);
    expect(out.status).toBe("absent");
  });

  test("a symlink OUT of home: unlink the LINK, never the target's tree", async () => {
    const keep = join(outside, "keep");
    await mkdir(keep, { recursive: true });
    await writeFile(join(keep, "data.txt"), "precious");
    const link = join(home, ".config/evil");
    await mkdir(join(home, ".config"), { recursive: true });
    await symlink(keep, link);

    const out = await deleteOwnedPath(link, home);
    expect(out.status).toBe("deleted-symlink");
    // The link is gone…
    await expect(lstat(link)).rejects.toThrow();
    // …but the target tree it pointed at survives untouched.
    expect(existsSync(join(keep, "data.txt"))).toBe(true);
  });

  test("refuses when a PARENT-component symlink escapes home", async () => {
    // ~/.config is itself a symlink to an outside dir; ~/.config/real resolves
    // outside home. Deletion must refuse rather than rm through the parent link.
    const realOutside = join(outside, "cfg");
    await mkdir(join(realOutside, "real"), { recursive: true });
    await writeFile(join(realOutside, "real", "keep.txt"), "x");
    await symlink(realOutside, join(home, ".config"));

    const out = await deleteOwnedPath(join(home, ".config", "real"), home);
    expect(out.status).toBe("refused-escape");
    expect(existsSync(join(realOutside, "real", "keep.txt"))).toBe(true);
  });

  test("refuses a path lexically outside home", async () => {
    const out = await deleteOwnedPath(join(outside, "x"), home);
    expect(out.status).toBe("refused-escape");
  });
});
