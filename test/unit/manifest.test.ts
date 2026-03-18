import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readManifest, assessRisk, formatCapabilities } from "../../src/lib/manifest.js";
import type { PaiManifest } from "../../src/types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pai-manifest-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readManifest", () => {
  test("parses valid pai-manifest.yaml", async () => {
    await Bun.write(
      join(tempDir, "pai-manifest.yaml"),
      `name: TestSkill
version: 1.0.0
type: skill
author:
  name: testuser
  github: testuser
capabilities:
  filesystem:
    read:
      - "~/.claude/MEMORY/"
  network: []
  bash:
    allowed: false
  secrets: []
`
    );

    const manifest = await readManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe("TestSkill");
    expect(manifest!.version).toBe("1.0.0");
    expect(manifest!.capabilities.filesystem?.read).toEqual([
      "~/.claude/MEMORY/",
    ]);
  });

  test("returns null for missing file", async () => {
    const manifest = await readManifest(tempDir);
    expect(manifest).toBeNull();
  });

  test("throws for invalid manifest (missing required fields)", async () => {
    await Bun.write(
      join(tempDir, "pai-manifest.yaml"),
      `description: "not a valid manifest"\n`
    );

    await expect(readManifest(tempDir)).rejects.toThrow("missing required fields");
  });
});

describe("assessRisk", () => {
  const base: PaiManifest = {
    name: "Test",
    version: "1.0.0",
    type: "skill",
    author: { name: "test", github: "test" },
    capabilities: {
      filesystem: { read: [], write: [] },
      network: [],
      bash: { allowed: false },
      secrets: [],
    },
  };

  test("low risk: filesystem only", () => {
    const m = { ...base, capabilities: { ...base.capabilities, filesystem: { read: ["/a"] } } };
    expect(assessRisk(m)).toBe("low");
  });

  test("medium risk: network access", () => {
    const m = {
      ...base,
      capabilities: {
        ...base.capabilities,
        network: [{ domain: "api.example.com", reason: "test" }],
      },
    };
    expect(assessRisk(m)).toBe("medium");
  });

  test("medium risk: secrets", () => {
    const m = {
      ...base,
      capabilities: { ...base.capabilities, secrets: ["API_KEY"] },
    };
    expect(assessRisk(m)).toBe("medium");
  });

  test("high risk: network + file write", () => {
    const m = {
      ...base,
      capabilities: {
        ...base.capabilities,
        network: [{ domain: "api.example.com", reason: "test" }],
        filesystem: { write: ["/output"] },
      },
    };
    expect(assessRisk(m)).toBe("high");
  });

  test("high risk: network + secrets", () => {
    const m = {
      ...base,
      capabilities: {
        ...base.capabilities,
        network: [{ domain: "api.example.com", reason: "test" }],
        secrets: ["API_KEY"],
      },
    };
    expect(assessRisk(m)).toBe("high");
  });
});

describe("formatCapabilities", () => {
  test("formats all capability types", () => {
    const m: PaiManifest = {
      name: "Test",
      version: "1.0.0",
      type: "skill",
      author: { name: "test", github: "test" },
      capabilities: {
        filesystem: { read: ["/read"], write: ["/write"] },
        network: [{ domain: "api.example.com", reason: "API" }],
        bash: { allowed: true, restricted_to: ["bun src/tool.ts"] },
        secrets: ["API_KEY"],
      },
    };

    const lines = formatCapabilities(m);
    expect(lines.some((l) => l.includes("Read: /read"))).toBe(true);
    expect(lines.some((l) => l.includes("Write: /write"))).toBe(true);
    expect(lines.some((l) => l.includes("Network: api.example.com"))).toBe(true);
    expect(lines.some((l) => l.includes("Bash: bun src/tool.ts"))).toBe(true);
    expect(lines.some((l) => l.includes("Secret: API_KEY"))).toBe(true);
  });

  test("shows unrestricted bash as red", () => {
    const m: PaiManifest = {
      name: "Test",
      version: "1.0.0",
      type: "skill",
      author: { name: "test", github: "test" },
      capabilities: {
        bash: { allowed: true },
      },
    };

    const lines = formatCapabilities(m);
    expect(lines.some((l) => l.includes("🔴") && l.includes("unrestricted"))).toBe(
      true
    );
  });
});
