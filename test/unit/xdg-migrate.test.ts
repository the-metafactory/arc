/**
 * #287 (P2) — arc adopts the XDG layout for its OWN dirs, migrates on touch, and
 * relinks installed packages in lockstep. These tests exercise the trust-lane
 * crux: a botched relink must never break a real install, so copy-keep-source +
 * db-rewrite + symlink re-point are verified end-to-end and under partial failure.
 *
 * Every path resolves under a scratch `$HOME` (seam-injected) — zero real-home
 * or real-`~/.config` access, per the arc test-isolation rule.
 */

import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createArcPaths, getDefaultHost } from "../../src/lib/paths.js";
import { openDatabase, recordInstall, getSkill } from "../../src/lib/db.js";
import {
  migrateArcDirsIfNeeded,
  legacyArcLayout,
  toArcDirLayout,
  XDG_MIGRATION_MARKER,
} from "../../src/lib/xdg-migrate.js";
import type { ArcManifest, InstalledSkill } from "../../src/types.js";

function seededSkill(overrides: Partial<InstalledSkill>): InstalledSkill {
  return {
    name: "mypkg",
    version: "1.0.0",
    repo_url: "https://example.test/mypkg",
    install_path: "",
    skill_dir: "",
    status: "active",
    artifact_type: "skill",
    tier: "custom",
    customization_path: null,
    install_source: null,
    library_name: null,
    installed_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

const EMPTY_MANIFEST = { name: "mypkg", version: "1.0.0", type: "skill" } as ArcManifest;

/**
 * Seed a legacy `~/.config/metafactory` install under `home`: a cloned repo, a
 * packages.db row whose paths point into it, and a host symlink into it.
 * Returns the resolved legacy + next layouts and the host.
 */
function seedLegacyInstall(home: string) {
  const legacy = legacyArcLayout({ home });
  const next = toArcDirLayout(createArcPaths(undefined, { home, env: { PATH: "" } }));
  const host = getDefaultHost({ root: join(home, ".claude") });

  // Legacy cloned repo: <legacyRepos>/mypkg/skill/SKILL.md
  const legacyRepo = join(legacy.reposDir, "mypkg");
  const legacySkillDir = join(legacyRepo, "skill");
  mkdirSync(legacySkillDir, { recursive: true });
  writeFileSync(join(legacySkillDir, "SKILL.md"), "# mypkg\n");

  // Legacy sources.yaml + secrets (config-class children).
  mkdirSync(legacy.configRoot, { recursive: true });
  writeFileSync(legacy.sourcesPath, "sources: []\n");
  mkdirSync(legacy.secretsDir, { recursive: true });
  writeFileSync(join(legacy.secretsDir, "token"), "s3cr3t\n");

  // Legacy packages.db with a row pointing into the legacy repo.
  const db = openDatabase(legacy.dbPath);
  recordInstall(
    db,
    seededSkill({ install_path: legacyRepo, skill_dir: legacySkillDir }),
    EMPTY_MANIFEST,
  );
  db.close();

  // Host symlink: ~/.claude/skills/mypkg -> legacy skill dir.
  mkdirSync(host.paths.skillsDir, { recursive: true });
  const link = join(host.paths.skillsDir, "mypkg");
  symlinkSync(legacySkillDir, link);

  return { legacy, next, host, legacyRepo, legacySkillDir, link };
}

describe("#287 createArcPaths — XDG honored + ARC_CONFIG_ROOT single-tree", () => {
  test("$XDG_DATA_HOME / $XDG_CACHE_HOME are honored on the default layout", () => {
    const paths = createArcPaths(undefined, {
      home: "/scratch/home",
      env: { XDG_DATA_HOME: "/xdg/data", XDG_CACHE_HOME: "/xdg/cache", PATH: "" },
    });
    expect(paths.reposDir).toBe(join("/xdg/data", "metafactory", "arc", "repos"));
    expect(paths.dbPath).toBe(join("/xdg/data", "metafactory", "arc", "packages.db"));
    expect(paths.cachePath).toBe(join("/xdg/cache", "metafactory", "arc", "cache"));
  });

  test("ARC_CONFIG_ROOT keeps the legacy single-tree layout (pkg/ tails preserved)", () => {
    const paths = createArcPaths(undefined, {
      home: "/scratch/home",
      env: { ARC_CONFIG_ROOT: "/relocated/arc", XDG_DATA_HOME: "/xdg/data", PATH: "" },
    });
    // ARC_CONFIG_ROOT wins over $XDG_* — everything collapses onto it, byte-for-byte
    // identical to pre-#287.
    expect(paths.configRoot).toBe("/relocated/arc");
    expect(paths.dataRoot).toBe("/relocated/arc");
    expect(paths.reposDir).toBe(join("/relocated/arc", "pkg", "repos"));
    expect(paths.cachePath).toBe(join("/relocated/arc", "pkg", "cache"));
    expect(paths.dbPath).toBe(join("/relocated/arc", "packages.db"));
  });
});

describe("#287 migrateArcDirsIfNeeded — migration-on-touch WITH relink", () => {
  test("moves repos, rewrites db rows, re-points the symlink, keeps legacy, idempotent", async () => {
    const home = mkdtempSync(join(tmpdir(), "arc-xdg-mig-"));
    try {
      const { legacy, next, host, legacySkillDir, link } = seedLegacyInstall(home);

      const result = await migrateArcDirsIfNeeded({ legacy, next, host, quiet: true });

      // (a) repos copied to the new data root; legacy KEPT (copy-keep-source).
      const nextSkillDir = join(next.reposDir, "mypkg", "skill");
      expect(existsSync(join(nextSkillDir, "SKILL.md"))).toBe(true);
      expect(existsSync(join(legacySkillDir, "SKILL.md"))).toBe(true);
      expect(result.reposCopied).toBe(true);

      // (b) packages.db row re-rooted at the NEW repos path.
      expect(result.dbRowsRewritten).toBe(1);
      const db = openDatabase(next.dbPath);
      try {
        const row = getSkill(db, "mypkg");
        expect(row?.install_path).toBe(join(next.reposDir, "mypkg"));
        expect(row?.skill_dir).toBe(nextSkillDir);
      } finally {
        db.close();
      }

      // (c) host symlink re-pointed at the NEW repo AND resolves.
      expect(result.symlinksRepointed).toBe(1);
      expect(readlinkSync(link)).toBe(nextSkillDir);
      expect(existsSync(link)).toBe(true); // follows the link → target file exists

      // config-class children migrated too.
      expect(result.configChildrenCopied).toContain("sources.yaml");
      expect(result.configChildrenCopied).toContain("secrets");
      expect(existsSync(next.sourcesPath)).toBe(true);
      expect(existsSync(join(next.secretsDir, "token"))).toBe(true);

      // completion marker written.
      expect(existsSync(join(next.dataRoot, XDG_MIGRATION_MARKER))).toBe(true);

      // Idempotent: a second run short-circuits, leaves everything intact.
      const second = await migrateArcDirsIfNeeded({ legacy, next, host, quiet: true });
      expect(second.migrated).toBe(false);
      expect(second.skipped).toBe("already-complete");
      expect(readlinkSync(link)).toBe(nextSkillDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fresh install (no legacy tree) is a no-op", async () => {
    const home = mkdtempSync(join(tmpdir(), "arc-xdg-fresh-"));
    try {
      const legacy = legacyArcLayout({ home });
      const next = toArcDirLayout(createArcPaths(undefined, { home, env: { PATH: "" } }));
      const host = getDefaultHost({ root: join(home, ".claude") });

      const result = await migrateArcDirsIfNeeded({ legacy, next, host, quiet: true });
      expect(result.migrated).toBe(false);
      expect(result.skipped).toBe("no-legacy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("same-layout (override / ARC_CONFIG_ROOT) is a no-op", async () => {
    const home = mkdtempSync(join(tmpdir(), "arc-xdg-same-"));
    try {
      // ARC_CONFIG_ROOT collapses next onto the legacy tree → legacy === next.
      const layout = toArcDirLayout(
        createArcPaths(undefined, { home, env: { ARC_CONFIG_ROOT: legacyArcLayout({ home }).configRoot, PATH: "" } }),
      );
      const host = getDefaultHost({ root: join(home, ".claude") });
      const result = await migrateArcDirsIfNeeded({
        legacy: legacyArcLayout({ home }),
        next: layout,
        host,
        quiet: true,
      });
      expect(result.migrated).toBe(false);
      expect(result.skipped).toBe("same-layout");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("#287 migrateArcDirsIfNeeded — partial failure leaves legacy working", () => {
  test("a mid-relink failure never dangles a symlink; legacy still resolves; no marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "arc-xdg-fail-"));
    try {
      const { legacy, next, host, legacySkillDir, link } = seedLegacyInstall(home);

      // Force the db-rewrite step to throw BEFORE relink: pre-create next.dbPath
      // as a DIRECTORY so `openDatabase` cannot open it. The migration must catch,
      // write no marker, and leave the legacy symlink pointing at the legacy repo.
      mkdirSync(next.dataRoot, { recursive: true });
      mkdirSync(next.dbPath, { recursive: true });

      const result = await migrateArcDirsIfNeeded({ legacy, next, host, quiet: true });

      // Migration did not complete: no marker, warnings recorded.
      expect(existsSync(join(next.dataRoot, XDG_MIGRATION_MARKER))).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);

      // Crux: the legacy symlink is untouched (relink never ran) and still
      // resolves to the legacy repo, which copy-keep-source never removed.
      expect(readlinkSync(link)).toBe(legacySkillDir);
      expect(existsSync(link)).toBe(true);
      expect(existsSync(join(legacySkillDir, "SKILL.md"))).toBe(true);

      // The legacy packages.db is untouched — its row still points at the legacy repo.
      const db = openDatabase(legacy.dbPath);
      try {
        expect(getSkill(db, "mypkg")?.install_path).toBe(join(legacy.reposDir, "mypkg"));
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
