/**
 * F-6b (arc#228) end-to-end: agent identity provisioning through `install()`.
 *
 * Verifies the full flow — a type:agent package install drives the identity
 * hook → NKey seed created at the canonical (sandboxed) path → instance state
 * scaffolded → a second install is idempotent. NKey + instance storage are
 * redirected via MF_NATS_DIR / MF_INSTANCE_DIR so the test never touches the
 * real ~/.config.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";

let env: TestEnv;
let prevNats: string | undefined;
let prevInstance: string | undefined;
let natsDir: string;
let instanceDir: string;

beforeEach(async () => {
  env = await createTestEnv();
  prevNats = process.env.MF_NATS_DIR;
  prevInstance = process.env.MF_INSTANCE_DIR;
  natsDir = join(env.root, "nats");
  instanceDir = join(env.root, "agents", "scout");
  process.env.MF_NATS_DIR = natsDir;
  process.env.MF_INSTANCE_DIR = instanceDir;
});

afterEach(async () => {
  if (prevNats === undefined) delete process.env.MF_NATS_DIR;
  else process.env.MF_NATS_DIR = prevNats;
  if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
  else process.env.MF_INSTANCE_DIR = prevInstance;
  await env.cleanup();
});

describe("install() — F-6b agent identity provisioning", () => {
  test("provisions NKey + DID + instance state for a type:agent package", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent" });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);

    // NKey seed at the canonical (sandboxed) path, chmod 600.
    const seedPath = join(natsDir, "scout.nk");
    expect(existsSync(seedPath)).toBe(true);
    expect(statSync(seedPath).mode & 0o777).toBe(0o600);

    // Instance state scaffolded.
    expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);
    expect(existsSync(join(instanceDir, "dashboard.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "context", "repos.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "retros"))).toBe(true);

    // DID recorded in metadata.
    const db = new Database(join(instanceDir, "state.sqlite"), { readonly: true });
    try {
      const row = db
        .query("SELECT value FROM provisioning_metadata WHERE key = 'did'")
        .get() as { value: string } | null;
      expect(row?.value).toBe("did:mf:scout");
    } finally {
      db.close();
    }
  });

  test("does NOT provision identity for a non-agent (skill) package", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "PlainSkill", type: "skill" });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    // No NKey seed and no instance dir for a skill.
    expect(existsSync(join(natsDir, "PlainSkill.nk"))).toBe(false);
  });

  test("re-install (after remove) reuses the existing seed — idempotent", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent" });

    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const seedPath = join(natsDir, "scout.nk");
    const seedBefore = await readFile(seedPath, "utf-8");

    // Provision again directly through the same env (simulates upgrade re-run).
    const { maybeProvisionAgentIdentity } = await import(
      "../../src/lib/identity-provision.js"
    );
    const second = await maybeProvisionAgentIdentity(
      { type: "agent", name: "scout", identity: { id: "scout" } },
      { quiet: true },
    );
    expect(second?.provisioned).toBe(true);
    expect(await readFile(seedPath, "utf-8")).toBe(seedBefore);
    expect(second?.actions.find((a) => a.what === "nkey-seed")?.kind).toBe("skipped");
  });
});
