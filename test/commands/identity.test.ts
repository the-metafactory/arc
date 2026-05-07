import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `arc-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  process.env.METAFACTORY_CONFIG_DIR = testDir;
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  delete process.env.METAFACTORY_CONFIG_DIR;
});

async function freshImport() {
  const mod = await import(`../../src/commands/identity.ts?t=${Date.now()}-${Math.random()}`);
  return mod;
}

function writeRegistry(dir: string, data: any): void {
  writeFileSync(join(dir, "principals.json"), JSON.stringify(data));
}

function readRegistry(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "principals.json"), "utf-8"));
}

function validPrincipal(id: string, operator: string, key = "cmVtb3RlLXB1YmxpYy1rZXktdGVzdC1wYWRkaW5nLXg=") {
  return {
    id, display_name: id, operator, public_key: key,
    type: "agent" as const, created_at: new Date().toISOString(),
  };
}

// ── generateIdentity ─────────────────────

describe("generateIdentity", () => {
  test("creates key file and registers principal", async () => {
    const { generateIdentity } = await freshImport();
    const result = await generateIdentity("test-bot", "OP_TEST");

    expect(result.did).toBe("did:mf:test-bot");
    expect(result.publicKeyB64.length).toBeGreaterThan(20);
    expect(existsSync(join(testDir, "keys", "test-bot.key"))).toBe(true);

    const reg = readRegistry(testDir);
    expect(reg.principals).toHaveLength(1);
    expect(reg.principals[0].id).toBe("did:mf:test-bot");
    expect(reg.principals[0].operator).toBe("OP_TEST");
  });

  test("updates existing principal on force", async () => {
    const { generateIdentity } = await freshImport();
    const r1 = await generateIdentity("test-bot", "OP_TEST");
    const r2 = await generateIdentity("test-bot", "OP_TEST", { force: true });

    expect(r2.publicKeyB64).not.toBe(r1.publicKeyB64);
    expect(readRegistry(testDir).principals).toHaveLength(1);
  });

  test("rejects invalid bot name", async () => {
    const { generateIdentity } = await freshImport();
    await expect(generateIdentity("INVALID", "OP_TEST")).rejects.toThrow(/invalid bot name/i);
    await expect(generateIdentity("../escape", "OP_TEST")).rejects.toThrow(/invalid bot name/i);
  });

  test("rejects trailing hyphen", async () => {
    const { generateIdentity } = await freshImport();
    await expect(generateIdentity("foo-", "OP_TEST")).rejects.toThrow(/invalid bot name/i);
  });

  test("rejects consecutive hyphens", async () => {
    const { generateIdentity } = await freshImport();
    await expect(generateIdentity("foo--bar", "OP_TEST")).rejects.toThrow(/invalid bot name/i);
  });
});

// ── importPrincipals — security paths ────

describe("importPrincipals — security", () => {
  test("adds new principals from import", async () => {
    const { generateIdentity, importPrincipals } = await freshImport();
    await generateIdentity("local-bot", "OP_LOCAL");

    const importFile = join(testDir, "remote.json");
    writeFileSync(importFile, JSON.stringify({
      version: 1, principals: [validPrincipal("did:mf:remote-bot", "OP_REMOTE")], trusted_hubs: [],
    }));

    importPrincipals(importFile);

    const reg = readRegistry(testDir);
    expect(reg.principals).toHaveLength(2);
    expect(reg.principals.map((p: any) => p.id).sort()).toEqual(["did:mf:local-bot", "did:mf:remote-bot"]);
  });

  test("rejects cross-operator key overwrite", async () => {
    const { generateIdentity, importPrincipals } = await freshImport();
    await generateIdentity("shared-name", "OP_LOCAL");

    const importFile = join(testDir, "attacker.json");
    writeFileSync(importFile, JSON.stringify({
      version: 1,
      principals: [validPrincipal("did:mf:shared-name", "OP_ATTACKER", "YXR0YWNrZXIta2V5LXBhZGRpbmctdG8tZm9ydHktY2hhcnM=")],
      trusted_hubs: [],
    }));

    importPrincipals(importFile);

    const reg = readRegistry(testDir);
    expect(reg.principals).toHaveLength(1);
    expect(reg.principals[0].operator).toBe("OP_LOCAL");
  });

  test("ignores trusted_hubs from import", async () => {
    const { importPrincipals } = await freshImport();

    const importFile = join(testDir, "hubs.json");
    writeFileSync(importFile, JSON.stringify({
      version: 1,
      principals: [validPrincipal("did:mf:new-bot", "OP_OTHER")],
      trusted_hubs: ["did:mf:evil-hub"],
    }));

    importPrincipals(importFile);

    const reg = readRegistry(testDir);
    expect(reg.trusted_hubs).toEqual([]);
  });

  test("rejects malformed principal (missing public_key)", async () => {
    const { importPrincipals } = await freshImport();

    const importFile = join(testDir, "bad.json");
    writeFileSync(importFile, JSON.stringify({
      version: 1,
      principals: [{ id: "did:mf:bad", operator: "OP", type: "agent" }],
      trusted_hubs: [],
    }));

    const origExitCode = process.exitCode;
    importPrincipals(importFile);
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;
  });

  test("rejects invalid file format", async () => {
    const { importPrincipals } = await freshImport();

    const importFile = join(testDir, "garbage.json");
    writeFileSync(importFile, '{"not": "a registry"}');

    const origExitCode = process.exitCode;
    importPrincipals(importFile);
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;
  });
});

// ── exportPrincipals ─────────────────────

describe("exportPrincipals", () => {
  test("exports only locally-generated principals", async () => {
    const { generateIdentity, importPrincipals, exportPrincipals } = await freshImport();
    await generateIdentity("my-bot", "OP_ME");

    // Import a remote principal (no local key file)
    const importFile = join(testDir, "remote.json");
    writeFileSync(importFile, JSON.stringify({
      version: 1, principals: [validPrincipal("did:mf:remote-bot", "OP_OTHER")], trusted_hubs: [],
    }));
    importPrincipals(importFile);

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => { chunks.push(chunk.toString()); return true; }) as any;
    exportPrincipals();
    process.stdout.write = origWrite;

    const output = JSON.parse(chunks.join(""));
    expect(output.principals).toHaveLength(1);
    expect(output.principals[0].id).toBe("did:mf:my-bot");
    expect(output.trusted_hubs).toEqual([]);
  });
});
