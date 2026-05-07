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

// Re-import each test to pick up env var changes
async function freshImport() {
  // Bun caches modules — use a cache-busting query param
  const mod = await import(`../../src/commands/identity.ts?t=${Date.now()}-${Math.random()}`);
  return mod;
}

describe("generateIdentity", () => {
  test("creates key file and registers principal", async () => {
    const { generateIdentity } = await freshImport();
    const result = await generateIdentity("test-bot", "OP_TEST");

    expect(result.did).toBe("did:mf:test-bot");
    expect(result.publicKeyB64).toBeTruthy();
    expect(result.publicKeyB64.length).toBeGreaterThan(20);

    // Key file exists
    const keyFile = join(testDir, "keys", "test-bot.key");
    expect(existsSync(keyFile)).toBe(true);

    // Registry updated
    const registry = JSON.parse(readFileSync(join(testDir, "principals.json"), "utf-8"));
    expect(registry.version).toBe(1);
    expect(registry.principals).toHaveLength(1);
    expect(registry.principals[0].id).toBe("did:mf:test-bot");
    expect(registry.principals[0].operator).toBe("OP_TEST");
    expect(registry.principals[0].public_key).toBe(result.publicKeyB64);
  });

  test("updates existing principal on force", async () => {
    const { generateIdentity } = await freshImport();
    const r1 = await generateIdentity("test-bot", "OP_TEST");
    const r2 = await generateIdentity("test-bot", "OP_TEST", { force: true });

    expect(r2.did).toBe("did:mf:test-bot");
    expect(r2.publicKeyB64).not.toBe(r1.publicKeyB64);

    const registry = JSON.parse(readFileSync(join(testDir, "principals.json"), "utf-8"));
    expect(registry.principals).toHaveLength(1);
    expect(registry.principals[0].public_key).toBe(r2.publicKeyB64);
  });

  test("rejects invalid bot name", async () => {
    const { generateIdentity } = await freshImport();
    await expect(generateIdentity("INVALID", "OP_TEST")).rejects.toThrow(/invalid bot name/i);
    await expect(generateIdentity("../escape", "OP_TEST")).rejects.toThrow(/invalid bot name/i);
  });
});

describe("importPrincipals", () => {
  test("merges principals from file", async () => {
    const { generateIdentity, importPrincipals } = await freshImport();
    await generateIdentity("local-bot", "OP_LOCAL");

    const importFile = join(testDir, "remote-principals.json");
    writeFileSync(importFile, JSON.stringify({
      version: 1,
      principals: [{
        id: "did:mf:remote-bot",
        display_name: "Remote Bot",
        operator: "OP_REMOTE",
        public_key: "cmVtb3RlLXB1YmxpYy1rZXktdGVzdC1wYWRkaW5nLXg=",
        type: "agent",
        created_at: new Date().toISOString(),
      }],
      trusted_hubs: [],
    }));

    importPrincipals(importFile);

    const registry = JSON.parse(readFileSync(join(testDir, "principals.json"), "utf-8"));
    expect(registry.principals).toHaveLength(2);
    const ids = registry.principals.map((p: any) => p.id).sort();
    expect(ids).toEqual(["did:mf:local-bot", "did:mf:remote-bot"]);
  });
});

describe("exportPrincipals", () => {
  test("outputs valid JSON to stdout", async () => {
    const { generateIdentity, exportPrincipals } = await freshImport();
    await generateIdentity("export-bot", "OP_EXPORT");

    // Capture stdout
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      chunks.push(chunk.toString());
      return true;
    }) as any;

    exportPrincipals();

    process.stdout.write = origWrite;

    const output = JSON.parse(chunks.join(""));
    expect(output.version).toBe(1);
    expect(output.principals).toHaveLength(1);
    expect(output.principals[0].id).toBe("did:mf:export-bot");
  });
});
