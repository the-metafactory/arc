import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  beginInstallTransaction,
  completeInstallTransaction,
} from "../../src/lib/install-transaction.js";
import { createTestEnv } from "../helpers/test-env.js";
import { installFakeSoma } from "../helpers/fake-soma.js";
import { createSkillManifest } from "../helpers/manifests.js";
import { getSkill } from "../../src/lib/db.js";
import type { ArcManifest } from "../../src/types.js";

describe("InstallTransaction", () => {
  test("captures extension rollback cleanup warnings in evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-install-tx-"));
    const statuslineDir = join(root, "statusline.d");
    await mkdir(statuslineDir, { recursive: true });
    await writeFile(join(statuslineDir, "blocked.sh"), "#!/bin/bash\n");

    const tx = beginInstallTransaction({
      packageName: "BlockedExtension",
      authorization: { approved: true },
    });
    tx.recordExtensions(["statusline:blocked"], root);

    const evidence = await tx.rollback();

    expect(evidence.rollback.attempted).toBe(true);
    expect(evidence.rollback.warnings).toEqual([
      expect.stringContaining("statusline:blocked"),
    ]);
  });

  test("soma projection cleanup records rollback without landed evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-soma-cleanup-"));
    const installPath = join(root, "package");
    const skillDir = join(installPath, "skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# SomaCleanup\n");

    const fakeSoma = await installFakeSoma({
      root,
      scriptForCallsPath: (path) =>
        `#!/bin/sh\necho "$@" >> "${path}"\nexit 0\n`,
    });
    try {
      const manifest = createSkillManifest("SomaCleanup", "somacleanup");

      const tx = beginInstallTransaction({
        packageName: "SomaCleanup",
        authorization: { approved: true },
      });
      tx.recordSomaProjectionCleanup(installPath, manifest);

      expect(tx.evidence.landedArtifacts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "soma-projection" })]),
      );

      const evidence = await tx.rollback();
      expect(evidence.rollback.attempted).toBe(true);

      const calls = (await readFile(fakeSoma.callsPath, "utf8")).trim().split("\n");
      expect(calls).toEqual([
        expect.stringMatching(/^unproject-skill .+\/skill --apply$/),
      ]);
    } finally {
      fakeSoma.restore();
    }
  });

  test("postinstall failure rolls back Landed Artifacts before DB commit", async () => {
    const env = await createTestEnv();
    try {
      const installPath = join(env.root, "tx-package");
      const skillDir = join(installPath, "skill");
      const scriptsDir = join(installPath, "scripts");
      await mkdir(skillDir, { recursive: true });
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# TxRollback\n");
      await writeFile(join(scriptsDir, "postinstall.sh"), "#!/bin/bash\nexit 7\n");

      const skillLink = join(env.host.paths.skillsDir, "TxRollback");
      await symlink(skillDir, skillLink);

      const manifest: ArcManifest = {
        name: "TxRollback",
        version: "1.0.0",
        type: "skill",
        tier: "custom",
        provides: {
          skill: [{ trigger: "txrollback" }],
        },
        capabilities: {
          filesystem: { read: [], write: [] },
          network: [],
          bash: { allowed: false },
          secrets: [],
        },
        scripts: {
          postinstall: "scripts/postinstall.sh",
        },
      };

      const result = await completeInstallTransaction({
        host: env.host,
        db: env.db,
        repoUrl: "file://tx-package",
        installPath,
        manifest,
        authorization: { approved: true },
        symlinks: {
          symlinks: [skillLink],
          shims: { dir: env.arc.shimDir, names: [] },
        },
        quiet: true,
        sourceTier: "custom",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Postinstall script failed");
      expect(result.evidence?.rollback.attempted).toBe(true);
      expect(result.evidence?.dbCommitted).toBe(false);
      expect(result.evidence?.landedArtifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "symlink", path: skillLink }),
        ]),
      );
      expect(existsSync(skillLink)).toBe(false);
      expect(getSkill(env.db, "TxRollback")).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  test("successful Install Transaction commits DB row and Transaction Evidence", async () => {
    const env = await createTestEnv();
    try {
      const installPath = join(env.root, "tx-success");
      const skillDir = join(installPath, "skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# TxSuccess\n");

      const skillLink = join(env.host.paths.skillsDir, "TxSuccess");
      await symlink(skillDir, skillLink);

      const manifest: ArcManifest = {
        name: "TxSuccess",
        version: "1.2.3",
        type: "skill",
        tier: "custom",
        provides: {
          skill: [{ trigger: "txsuccess" }],
        },
        capabilities: {
          filesystem: { read: [], write: [] },
          network: [],
          bash: { allowed: false },
          secrets: [],
        },
      };

      const result = await completeInstallTransaction({
        host: env.host,
        db: env.db,
        repoUrl: "file://tx-success",
        installPath,
        manifest,
        authorization: { approved: true },
        symlinks: {
          symlinks: [skillLink],
          shims: { dir: env.arc.shimDir, names: [] },
        },
        quiet: true,
        sourceTier: "custom",
      });

      expect(result.success).toBe(true);
      expect(result.evidence?.dbCommitted).toBe(true);
      expect(result.evidence?.landedArtifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "symlink", path: skillLink }),
          expect.objectContaining({ kind: "db-row", name: "TxSuccess" }),
        ]),
      );

      const row = getSkill(env.db, "TxSuccess");
      expect(row).not.toBeNull();
      expect(row!.version).toBe("1.2.3");
      expect(row!.skill_dir).toBe(skillDir);
    } finally {
      await env.cleanup();
    }
  });
});
