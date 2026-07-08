/**
 * F-6b (arc#228) end-to-end: agent identity provisioning through `install()`.
 *
 * Verifies the full flow — a type:agent package install drives the identity
 * hook → NKey seed created at the canonical (sandboxed) path → instance state
 * scaffolded (only when the manifest opts in via `state`, arc#281) → a second
 * install is idempotent. NKey + instance + sidecar storage are redirected via
 * MF_NATS_DIR / MF_INSTANCE_DIR / MF_SIDECAR_DIR so the test never touches the
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
let prevSidecar: string | undefined;
let natsDir: string;
let instanceDir: string;
let sidecarDir: string;

beforeEach(async () => {
  env = await createTestEnv();
  prevNats = process.env.MF_NATS_DIR;
  prevInstance = process.env.MF_INSTANCE_DIR;
  prevSidecar = process.env.MF_SIDECAR_DIR;
  natsDir = join(env.root, "nats");
  instanceDir = join(env.root, "agents", "scout");
  sidecarDir = join(env.root, "sidecar");
  process.env.MF_NATS_DIR = natsDir;
  process.env.MF_INSTANCE_DIR = instanceDir;
  process.env.MF_SIDECAR_DIR = sidecarDir;
});

afterEach(async () => {
  if (prevNats === undefined) delete process.env.MF_NATS_DIR;
  else process.env.MF_NATS_DIR = prevNats;
  if (prevInstance === undefined) delete process.env.MF_INSTANCE_DIR;
  else process.env.MF_INSTANCE_DIR = prevInstance;
  if (prevSidecar === undefined) delete process.env.MF_SIDECAR_DIR;
  else process.env.MF_SIDECAR_DIR = prevSidecar;
  await env.cleanup();
});

/** A manifest `state` opt-in for a stateful agent (arc#281). */
const STATE_OPT_IN = { blueprint: "AgentState", version: ">=0.1.0" } as const;

describe("install() — F-6b agent identity provisioning", () => {
  test("provisions NKey + DID + instance state for a type:agent package WITH state", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent", state: STATE_OPT_IN });

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

    // Instance state scaffolded (state was declared).
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

    // Sidecar written (canonical record) marking state_scaffolded: true.
    const sidecarPath = join(sidecarDir, "scout.provision.json");
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf-8"));
    expect(sidecar.did).toBe("did:mf:scout");
    expect(sidecar.provisioned).toBe(true);
    expect(sidecar.state_scaffolded).toBe(true);
  });

  test("STATELESS agent (no state): identity + sidecar provisioned, NO instance dir", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent" });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);

    // Identity still provisioned — NKey seed exists, chmod 600.
    const seedPath = join(natsDir, "scout.nk");
    expect(existsSync(seedPath)).toBe(true);
    expect(statSync(seedPath).mode & 0o777).toBe(0o600);

    // NO instance-state scaffold: the whole instance dir is absent.
    expect(existsSync(instanceDir)).toBe(false);

    // Sidecar IS written (arc owns it for every agent), state_scaffolded: false.
    const sidecarPath = join(sidecarDir, "scout.provision.json");
    expect(existsSync(sidecarPath)).toBe(true);
    expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf-8"));
    expect(sidecar.did).toBe("did:mf:scout");
    expect(sidecar.provisioned).toBe(true);
    expect(sidecar.state_scaffolded).toBe(false);
    expect(sidecar.instance_dir).toBeUndefined();
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

  test("re-install (after remove) reuses the existing seed — idempotent (stateful)", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent", state: STATE_OPT_IN });

    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const seedPath = join(natsDir, "scout.nk");
    const seedBefore = await readFile(seedPath, "utf-8");

    // Provision again directly through the same env (simulates upgrade re-run).
    const { maybeProvisionAgentIdentity } = await import(
      "../../src/lib/identity-provision.js"
    );
    const second = await maybeProvisionAgentIdentity(
      { type: "agent", name: "scout", identity: { id: "scout" }, state: { blueprint: "AgentState", version: ">=0.1.0" } },
      { quiet: true },
    );
    expect(second?.provisioned).toBe(true);
    expect(second?.stateScaffolded).toBe(true);
    expect(await readFile(seedPath, "utf-8")).toBe(seedBefore);
    expect(second?.actions.find((a) => a.what === "nkey-seed")?.kind).toBe("skipped");
    // Sidecar re-write is idempotent (reports as skipped/updated on re-run).
    expect(second?.actions.find((a) => a.what === "provision-sidecar")?.kind).toBe("skipped");
  });

  test("re-install reuses the existing seed — idempotent (stateless)", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent" });

    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const seedPath = join(natsDir, "scout.nk");
    const seedBefore = await readFile(seedPath, "utf-8");

    const { maybeProvisionAgentIdentity } = await import(
      "../../src/lib/identity-provision.js"
    );
    const second = await maybeProvisionAgentIdentity(
      { type: "agent", name: "scout", identity: { id: "scout" } },
      { quiet: true },
    );
    expect(second?.provisioned).toBe(true);
    expect(second?.stateScaffolded).toBe(false);
    // Still no instance dir after a stateless re-run.
    expect(existsSync(instanceDir)).toBe(false);
    expect(await readFile(seedPath, "utf-8")).toBe(seedBefore);
    expect(second?.actions.find((a) => a.what === "nkey-seed")?.kind).toBe("skipped");
    expect(second?.actions.find((a) => a.what === "provision-sidecar")?.kind).toBe("skipped");
  });

  test("non-interactive install (yes=true) STILL surfaces a provisioning failure on stderr", async () => {
    // Force a fail-closed outcome via an invalid MF_AGENT_ID. Under `yes:true`
    // the per-action lines are suppressed, but the failure warning must remain
    // visible — a non-interactive install can't silently boot an unidentified
    // agent. (Security review MAJOR — both install sites use the same hook.)
    const prevAgent = process.env.MF_AGENT_ID;
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    };
    try {
      process.env.MF_AGENT_ID = "Bad_ID"; // violates the agent-id grammar
      const repo = await createMockSkillRepo(env.root, { name: "scout", type: "agent" });
      const result = await install({
        arc: env.arc,
        host: env.host,
        db: env.db,
        repoUrl: repo.url,
        yes: true,
      });
      // Install still succeeds (fail-closed is best-effort, never aborts).
      expect(result.success).toBe(true);
      // …but the failure is on the install log.
      expect(stderr).toContain("agent identity NOT provisioned for Bad_ID");
      // …and no seed was orphaned.
      expect(existsSync(join(natsDir, "Bad_ID.nk"))).toBe(false);
    } finally {
      process.stderr.write = originalWrite;
      if (prevAgent === undefined) delete process.env.MF_AGENT_ID;
      else process.env.MF_AGENT_ID = prevAgent;
    }
  });
});
