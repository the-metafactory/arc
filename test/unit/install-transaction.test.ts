import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { beginInstallTransaction } from "../../src/lib/install-transaction.js";

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
});
