/**
 * Tests for F-6e (arc#229) `arc secrets` CLI verbs.
 *
 * The verb implementations are pure functions over an injected SecretBackend +
 * a manifest resolver, so the suite is hermetic (no DB, no keychain). The thin
 * commander wrapper in cli.ts resolves the real backend + manifest.
 *
 * NEVER-LOG (issue §E): every verb prints NAMES only. The tests capture
 * stdout and assert no stored value ever appears.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FileBackend } from "../../src/lib/secrets.js";
import {
  secretsList,
  secretsCheck,
  secretsSet,
  secretsRotate,
  secretsRemove,
} from "../../src/commands/secrets.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;
let secretsRoot: string;
let logged: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-secrets-cmd-test-"));
  secretsRoot = join(tempDir, "secrets");
  await mkdir(secretsRoot, { recursive: true });
  logged = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
});

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  await rm(tempDir, { recursive: true, force: true });
});

function manifest(secrets: string[]): ArcManifest {
  return {
    name: "dev",
    version: "0.1.0",
    type: "agent",
    capabilities: { secrets },
  };
}

function assertNoValueLeaked(...values: string[]) {
  const all = logged.join("\n");
  for (const v of values) {
    expect(all).not.toContain(v);
  }
}

describe("secretsList", () => {
  test("lists stored secret names, never values", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("APPROVER_GH_TOKEN", "gh_pat_secret_value");
    const code = await secretsList({ agent: "dev", backend });
    expect(code).toBe(0);
    expect(logged.join("\n")).toContain("APPROVER_GH_TOKEN");
    assertNoValueLeaked("gh_pat_secret_value");
  });
});

describe("secretsCheck", () => {
  test("reports present + missing and exits 1 when any missing", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("HAVE", "v-have");
    const code = await secretsCheck(manifest(["HAVE", "MISSING"]), {
      agent: "dev",
      backend,
    });
    expect(code).toBe(1);
    const out = logged.join("\n");
    expect(out).toContain("HAVE");
    expect(out).toContain("MISSING");
    assertNoValueLeaked("v-have");
  });

  test("exits 0 when all declared secrets present", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("HAVE", "v");
    const code = await secretsCheck(manifest(["HAVE"]), { agent: "dev", backend });
    expect(code).toBe(0);
  });
});

describe("secretsSet", () => {
  test("--from-env stores the value from the env var", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const code = await secretsSet("APPROVER_GH_TOKEN", {
      agent: "dev",
      backend,
      fromEnv: true,
      env: { APPROVER_GH_TOKEN: "from-env-value" },
    });
    expect(code).toBe(0);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBe("from-env-value");
    assertNoValueLeaked("from-env-value");
  });

  test("--from-env with the env var absent fails with exit 1 (no value logged)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const code = await secretsSet("APPROVER_GH_TOKEN", {
      agent: "dev",
      backend,
      fromEnv: true,
      env: {},
    });
    expect(code).toBe(1);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBeNull();
  });

  test("interactive prompt stores the typed value", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const code = await secretsSet("GITHUB_TOKEN", {
      agent: "dev",
      backend,
      prompt: async () => "typed-secret",
    });
    expect(code).toBe(0);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("typed-secret");
    assertNoValueLeaked("typed-secret");
  });
});

describe("secretsRotate", () => {
  test("replaces the stored value (delete-then-add semantics)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "old-value");
    const code = await secretsRotate("GITHUB_TOKEN", {
      agent: "dev",
      backend,
      prompt: async () => "new-value",
    });
    expect(code).toBe(0);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("new-value");
    assertNoValueLeaked("old-value", "new-value");
  });

  test("rotate aborts (exit 1) on empty input, leaving the old value intact", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "old-value");
    const code = await secretsRotate("GITHUB_TOKEN", {
      agent: "dev",
      backend,
      prompt: async () => "",
    });
    expect(code).toBe(1);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("old-value");
  });
});

describe("secretsRemove", () => {
  test("removes one named secret", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "v");
    const code = await secretsRemove({ agent: "dev", backend, name: "GITHUB_TOKEN" });
    expect(code).toBe(0);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBeNull();
  });

  test("removes all declared secrets when no name is given", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("A", "1");
    await backend.store("B", "2");
    const code = await secretsRemove({
      agent: "dev",
      backend,
      manifest: manifest(["A", "B"]),
    });
    expect(code).toBe(0);
    expect(await backend.retrieve("A")).toBeNull();
    expect(await backend.retrieve("B")).toBeNull();
  });
});
