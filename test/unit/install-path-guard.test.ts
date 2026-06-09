import { describe, test, expect } from "bun:test";
import path from "path";
import { isInsideRepos, repoNameFromPreExtracted } from "../../src/lib/repo-name.js";

/**
 * Regression coverage for #219 — the cross-platform install path guard.
 *
 * The operator cannot test on Windows, so these win32 cases ARE the
 * verification that the fix works on Windows. They exercise the `\`-separator
 * (Windows) path via `path.win32` explicitly, independent of the host OS.
 */
describe("isInsideRepos — containment guard", () => {
  describe("win32 (Windows separators)", () => {
    const reposDir = "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos";

    test("#219 git-URL repro: a valid child path is INSIDE", () => {
      const installPath = "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos\\soma";
      expect(isInsideRepos(reposDir, installPath, path.win32)).toBe(true);
    });

    test("#219 registry repro: a valid scoped child path is INSIDE", () => {
      const installPath =
        "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos\\metafactory__soma";
      expect(isInsideRepos(reposDir, installPath, path.win32)).toBe(true);
    });

    test("a `..`-escape attempt is NOT inside (escape protection intact)", () => {
      const installPath =
        "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos\\..\\evil";
      expect(isInsideRepos(reposDir, installPath, path.win32)).toBe(false);
    });

    test("the repos dir itself is inside (boundary)", () => {
      expect(isInsideRepos(reposDir, reposDir, path.win32)).toBe(true);
    });

    test("a sibling directory sharing a prefix is NOT inside", () => {
      // `repos-evil` shares the `repos` text prefix but is not a child of `repos`.
      const installPath = "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos-evil\\soma";
      expect(isInsideRepos(reposDir, installPath, path.win32)).toBe(false);
    });
  });

  describe("posix (forward-slash separators — no regression)", () => {
    const reposDir = "/home/klittle/.config/metafactory/pkg/repos";

    test("a valid nested child path is INSIDE", () => {
      expect(isInsideRepos(reposDir, `${reposDir}/soma`, path.posix)).toBe(true);
    });

    test("a `..`-escape attempt is NOT inside", () => {
      expect(isInsideRepos(reposDir, `${reposDir}/../evil`, path.posix)).toBe(false);
    });

    test("the repos dir itself is inside (boundary)", () => {
      expect(isInsideRepos(reposDir, reposDir, path.posix)).toBe(true);
    });

    test("a sibling directory sharing a prefix is NOT inside", () => {
      expect(isInsideRepos(reposDir, `${reposDir}-evil/soma`, path.posix)).toBe(false);
    });
  });
});

describe("repoNameFromPreExtracted — repo-name extraction", () => {
  test("win32: returns the basename, not the whole path (#219 registry repro)", () => {
    const preExtracted =
      "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos\\metafactory__soma";
    expect(repoNameFromPreExtracted(preExtracted, path.win32)).toBe("metafactory__soma");
  });

  test("posix: returns the basename", () => {
    expect(
      repoNameFromPreExtracted("/home/klittle/.config/metafactory/pkg/repos/soma", path.posix),
    ).toBe("soma");
  });

  test("win32: trailing separator does not yield an empty name", () => {
    const preExtracted =
      "C:\\Users\\klittle\\.config\\metafactory\\pkg\\repos\\metafactory__soma\\";
    expect(repoNameFromPreExtracted(preExtracted, path.win32)).toBe("metafactory__soma");
  });

  test("undefined pre-extracted path yields undefined (caller falls back)", () => {
    expect(repoNameFromPreExtracted(undefined, path.win32)).toBeUndefined();
  });
});
