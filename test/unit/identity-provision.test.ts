import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  agentDidFromId,
  nkeyPathForAgent,
  instanceDirForAgent,
  provisionAgentIdentity,
  maybeProvisionAgentIdentity,
  reportProvisioningResult,
} from "../../src/lib/identity-provision.js";

/** Capture everything written to process.stderr during `fn`. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

async function sandbox(): Promise<{ root: string; natsDir: string; agentsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "arc-f6b-"));
  return {
    root,
    natsDir: join(root, "nats"),
    agentsDir: join(root, "agents"),
  };
}

function readMetadata(instanceDir: string): Record<string, string> {
  const db = new Database(join(instanceDir, "state.sqlite"), { readonly: true });
  try {
    const rows = db
      .query("SELECT key, value FROM provisioning_metadata")
      .all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

describe("agentDidFromId", () => {
  test("derives did:mf:<id> with no principal segment", () => {
    expect(agentDidFromId("forge")).toBe("did:mf:forge");
    expect(agentDidFromId("dev")).toBe("did:mf:dev");
    expect(agentDidFromId("approver")).toBe("did:mf:approver");
  });
});

describe("path resolution", () => {
  test("nkeyPathForAgent honors override base", () => {
    expect(nkeyPathForAgent("forge", "/tmp/nats")).toBe("/tmp/nats/forge.nk");
  });
  test("instanceDirForAgent honors override base", () => {
    expect(instanceDirForAgent("forge", "/tmp/agents")).toBe("/tmp/agents/forge");
  });
  test("default nkey path lives under ~/.config/nats", () => {
    expect(nkeyPathForAgent("forge")).toMatch(/\.config\/nats\/forge\.nk$/);
  });
});

describe("provisionAgentIdentity — happy path", () => {
  test("creates NKey seed (chmod 600), scaffolds state, records metadata", async () => {
    const { natsDir, agentsDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    const result = await provisionAgentIdentity({
      agentId: "forge",
      instanceDir,
      natsDir,
      quiet: true,
    });

    expect(result.provisioned).toBe(true);
    expect(result.did).toBe("did:mf:forge");
    expect(result.warning).toBeUndefined();

    // NKey seed exists at the canonical path with mode 600.
    const seedPath = join(natsDir, "forge.nk");
    expect(result.nkeySeedPath).toBe(seedPath);
    expect(existsSync(seedPath)).toBe(true);
    const seedStat = await stat(seedPath);
    expect(seedStat.mode & 0o777).toBe(0o600);
    // The seed content is an NKey user seed ('SU…' prefix).
    const seed = (await readFile(seedPath, "utf-8")).trim();
    expect(seed.startsWith("SU")).toBe(true);
    // Pubkey is derived self-contained ('U…' prefix) and returned.
    expect(result.nkeyPub.startsWith("U")).toBe(true);

    // Instance-state scaffold — four-folder layout.
    expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);
    expect(existsSync(join(instanceDir, "dashboard.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "context", "repos.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "context", "channels.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "retros"))).toBe(true);

    // Metadata records provisioning facts.
    const meta = readMetadata(instanceDir);
    expect(meta.provisioned).toBe("1");
    expect(meta.did).toBe("did:mf:forge");
    expect(meta.nkey_seed_path).toBe(seedPath);
    expect(meta.nkey_pub).toBe(result.nkeyPub);
    expect(meta.provisioned_at).toBeTruthy();
  });
});

describe("provisionAgentIdentity — idempotency (Rule 2)", () => {
  test("second run reuses the seed and skips operator-edited files", async () => {
    const { natsDir, agentsDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    const first = await provisionAgentIdentity({ agentId: "forge", instanceDir, natsDir, quiet: true });
    const seedBefore = await readFile(first.nkeySeedPath, "utf-8");

    // Operator edits dashboard.md — must survive a re-run.
    const dashboardPath = join(instanceDir, "dashboard.md");
    await Bun.write(dashboardPath, "# operator-edited dashboard\n");

    const second = await provisionAgentIdentity({ agentId: "forge", instanceDir, natsDir, quiet: true });

    expect(second.provisioned).toBe(true);
    // Seed is byte-identical (reused, not regenerated).
    const seedAfter = await readFile(second.nkeySeedPath, "utf-8");
    expect(seedAfter).toBe(seedBefore);
    // Re-run reports the seed as skipped/exists.
    expect(second.actions.find((a) => a.what === "nkey-seed")?.kind).toBe("skipped");
    // Operator-edited dashboard is untouched.
    expect(await readFile(dashboardPath, "utf-8")).toBe("# operator-edited dashboard\n");
  });
});

describe("provisionAgentIdentity — fail-closed (Rule 1)", () => {
  test("invalid agent id is refused, nothing written", async () => {
    const { natsDir, agentsDir } = await sandbox();
    const result = await provisionAgentIdentity({
      agentId: "Bad_ID",
      instanceDir: join(agentsDir, "bad"),
      natsDir,
      quiet: true,
    });
    expect(result.provisioned).toBe(false);
    expect(result.warning).toContain("invalid agent id");
    expect(existsSync(join(natsDir, "Bad_ID.nk"))).toBe(false);
  });

  test("uncreatable instance dir refuses to wire identity (no orphan seed)", async () => {
    const { natsDir, root } = await sandbox();
    // Make a read-only parent so mkdir of the instance dir fails (EACCES).
    const lockedParent = join(root, "locked");
    await Bun.write(join(lockedParent, ".keep"), "");
    await chmod(lockedParent, 0o500);
    try {
      const instanceDir = join(lockedParent, "child", "forge");
      const result = await provisionAgentIdentity({
        agentId: "forge",
        instanceDir,
        natsDir,
        quiet: true,
      });
      expect(result.provisioned).toBe(false);
      expect(result.warning).toMatch(/cannot create agent instance dir|refusing to wire identity/);
      // Fail-closed: no NKey seed orphaned when the skeleton can't be created.
      expect(existsSync(join(natsDir, "forge.nk"))).toBe(false);
    } finally {
      await chmod(lockedParent, 0o700); // allow cleanup
    }
  });
});

describe("maybeProvisionAgentIdentity — install.ts hook", () => {
  test("no-op for non-agent packages", async () => {
    expect(await maybeProvisionAgentIdentity({ type: "skill", name: "Thinking" })).toBeNull();
  });

  test("provisions agent using manifest.identity.id, honoring MF_INSTANCE_DIR", async () => {
    const { natsDir, agentsDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");
    const prevInstance = process.env.MF_INSTANCE_DIR;
    const prevNats = process.env.MF_NATS_DIR;
    try {
      process.env.MF_INSTANCE_DIR = instanceDir;
      process.env.MF_NATS_DIR = natsDir; // keep the seed out of the real ~/.config
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Forge Bot", identity: { id: "forge", displayName: "Forge" } },
        { quiet: true },
      );
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe("forge");
      expect(result!.did).toBe("did:mf:forge");
      expect(result!.instanceDir).toBe(instanceDir);
      expect(result!.nkeySeedPath).toBe(join(natsDir, "forge.nk"));
      expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);
      expect(existsSync(join(natsDir, "forge.nk"))).toBe(true);
      const meta = readMetadata(instanceDir);
      expect(meta.did).toBe("did:mf:forge");
    } finally {
      if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
      else process.env.MF_INSTANCE_DIR = prevInstance;
      if (prevNats === undefined) delete process.env.MF_NATS_DIR;
      else process.env.MF_NATS_DIR = prevNats;
    }
  });

  test("MF_AGENT_ID overrides the manifest id", async () => {
    const { agentsDir, natsDir } = await sandbox();
    const instanceDir = join(agentsDir, "override");
    const prevAgent = process.env.MF_AGENT_ID;
    const prevInstance = process.env.MF_INSTANCE_DIR;
    const prevNats = process.env.MF_NATS_DIR;
    try {
      process.env.MF_AGENT_ID = "override";
      process.env.MF_INSTANCE_DIR = instanceDir;
      process.env.MF_NATS_DIR = natsDir;
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Some Agent", identity: { id: "ignored" } },
        { quiet: true },
      );
      expect(result!.agentId).toBe("override");
      expect(result!.did).toBe("did:mf:override");
    } finally {
      if (prevAgent === undefined) delete process.env.MF_AGENT_ID;
      else process.env.MF_AGENT_ID = prevAgent;
      if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
      else process.env.MF_INSTANCE_DIR = prevInstance;
      if (prevNats === undefined) delete process.env.MF_NATS_DIR;
      else process.env.MF_NATS_DIR = prevNats;
    }
  });

  test("falls back to a slug of manifest.name when no id is declared", async () => {
    const { agentsDir, natsDir } = await sandbox();
    const instanceDir = join(agentsDir, "dev-loop-bot");
    const prevInstance = process.env.MF_INSTANCE_DIR;
    const prevNats = process.env.MF_NATS_DIR;
    try {
      process.env.MF_INSTANCE_DIR = instanceDir;
      process.env.MF_NATS_DIR = natsDir;
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Dev Loop Bot" },
        { quiet: true },
      );
      expect(result!.agentId).toBe("dev-loop-bot");
      expect(result!.did).toBe("did:mf:dev-loop-bot");
    } finally {
      if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
      else process.env.MF_INSTANCE_DIR = prevInstance;
      if (prevNats === undefined) delete process.env.MF_NATS_DIR;
      else process.env.MF_NATS_DIR = prevNats;
    }
  });
});

describe("reportProvisioningResult — failure visibility (MAJOR)", () => {
  test("null result (non-agent) writes nothing", async () => {
    const out = await captureStderr(() => reportProvisioningResult(null));
    expect(out).toBe("");
  });

  test("successful provision writes nothing", async () => {
    const { natsDir, agentsDir } = await sandbox();
    const result = await provisionAgentIdentity({
      agentId: "forge",
      instanceDir: join(agentsDir, "forge"),
      natsDir,
      quiet: true,
    });
    const out = await captureStderr(() => reportProvisioningResult(result));
    expect(out).toBe("");
  });

  test("fail-closed SKIP with quiet=true STILL surfaces a stderr warning", async () => {
    const { natsDir, agentsDir } = await sandbox();
    // quiet:true suppresses the per-action record() lines, but a fail-closed
    // outcome (here: invalid id) must remain visible on the install log.
    const result = await provisionAgentIdentity({
      agentId: "Bad_ID",
      instanceDir: join(agentsDir, "bad"),
      natsDir,
      quiet: true,
    });
    expect(result.provisioned).toBe(false);

    const out = await captureStderr(() => reportProvisioningResult(result));
    expect(out).toContain("agent identity NOT provisioned");
    expect(out).toContain("Bad_ID");
    expect(out).toContain(result.warning!);
  });

  test("EACCES fail-closed under quiet=true surfaces a stderr warning", async () => {
    const { natsDir, root } = await sandbox();
    const lockedParent = join(root, "locked");
    await Bun.write(join(lockedParent, ".keep"), "");
    await chmod(lockedParent, 0o500);
    try {
      const result = await provisionAgentIdentity({
        agentId: "forge",
        instanceDir: join(lockedParent, "child", "forge"),
        natsDir,
        quiet: true,
      });
      expect(result.provisioned).toBe(false);
      const out = await captureStderr(() => reportProvisioningResult(result));
      expect(out).toContain("agent identity NOT provisioned for forge");
    } finally {
      await chmod(lockedParent, 0o700);
    }
  });
});
