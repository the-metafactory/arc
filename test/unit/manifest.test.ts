import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  readManifest,
  assessRisk,
  formatCapabilities,
  normalizeNetworkEntry,
  normalizeCapabilities,
  MANIFEST_FILENAME,
  LEGACY_MANIFEST_FILENAME,
} from "../../src/lib/manifest.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pai-manifest-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readManifest", () => {
  test("parses valid arc-manifest.yaml", async () => {
    await Bun.write(
      join(tempDir, MANIFEST_FILENAME),
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
    expect(manifest!.capabilities?.filesystem?.read).toEqual([
      "~/.claude/MEMORY/",
    ]);
  });

  test("falls back to legacy pai-manifest.yaml", async () => {
    await Bun.write(
      join(tempDir, LEGACY_MANIFEST_FILENAME),
      `name: LegacySkill
version: 2.0.0
type: skill
author:
  name: testuser
  github: testuser
capabilities:
  filesystem:
    read: []
  network: []
  bash:
    allowed: false
  secrets: []
`
    );

    const manifest = await readManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe("LegacySkill");
    expect(manifest!.version).toBe("2.0.0");
  });

  test("prefers arc-manifest.yaml over pai-manifest.yaml", async () => {
    await Bun.write(
      join(tempDir, MANIFEST_FILENAME),
      `name: NewName
version: 3.0.0
type: skill
author:
  name: testuser
  github: testuser
capabilities:
  filesystem:
    read: []
  network: []
  bash:
    allowed: false
  secrets: []
`
    );
    await Bun.write(
      join(tempDir, LEGACY_MANIFEST_FILENAME),
      `name: OldName
version: 1.0.0
type: skill
author:
  name: testuser
  github: testuser
capabilities:
  filesystem:
    read: []
  network: []
  bash:
    allowed: false
  secrets: []
`
    );

    const manifest = await readManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe("NewName");
    expect(manifest!.version).toBe("3.0.0");
  });

  test("returns null for missing file", async () => {
    const manifest = await readManifest(tempDir);
    expect(manifest).toBeNull();
  });

  test("throws for invalid manifest (missing required fields)", async () => {
    await Bun.write(
      join(tempDir, MANIFEST_FILENAME),
      `description: "not a valid manifest"\n`
    );

    await expect(readManifest(tempDir)).rejects.toThrow("missing required fields");
  });
});

describe("assessRisk", () => {
  const base: ArcManifest = {
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
    const m: ArcManifest = {
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
    const m: ArcManifest = {
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

// Regression tests for https://github.com/the-metafactory/arc/issues/79
describe("normalizeNetworkEntry", () => {
  test("string shorthand becomes object with empty reason", () => {
    expect(normalizeNetworkEntry("github.com")).toEqual({
      domain: "github.com",
      reason: "",
    });
  });

  test("object with domain + reason passes through", () => {
    expect(normalizeNetworkEntry({ domain: "github.com", reason: "clone repos" })).toEqual({
      domain: "github.com",
      reason: "clone repos",
    });
  });

  test("object missing reason gets empty reason", () => {
    expect(normalizeNetworkEntry({ domain: "github.com" })).toEqual({
      domain: "github.com",
      reason: "",
    });
  });

  test("object with non-string reason gets empty reason", () => {
    expect(normalizeNetworkEntry({ domain: "github.com", reason: 42 })).toEqual({
      domain: "github.com",
      reason: "",
    });
  });

  test("object missing domain rejected", () => {
    expect(normalizeNetworkEntry({ reason: "no domain" })).toBeNull();
  });

  test("number rejected", () => {
    expect(normalizeNetworkEntry(42)).toBeNull();
  });

  test("null rejected", () => {
    expect(normalizeNetworkEntry(null)).toBeNull();
  });
});

describe("normalizeCapabilities", () => {
  test("mutates string shorthand into object form", () => {
    const m: ArcManifest = {
      name: "t",
      version: "1.0.0",
      type: "skill",
      capabilities: { network: ["github.com", "agentskills.io"] as any },
    };
    normalizeCapabilities(m, "arc-manifest.yaml");
    expect(m.capabilities!.network).toEqual([
      { domain: "github.com", reason: "" },
      { domain: "agentskills.io", reason: "" },
    ]);
  });

  test("mixed string + object entries both land as objects", () => {
    const m: ArcManifest = {
      name: "t",
      version: "1.0.0",
      type: "skill",
      capabilities: {
        network: [
          "github.com",
          { domain: "api.example.com", reason: "telemetry" },
        ] as any,
      },
    };
    normalizeCapabilities(m, "arc-manifest.yaml");
    expect(m.capabilities!.network).toEqual([
      { domain: "github.com", reason: "" },
      { domain: "api.example.com", reason: "telemetry" },
    ]);
  });

  test("no-op when capabilities absent", () => {
    const m: ArcManifest = { name: "t", version: "1.0.0", type: "skill" };
    expect(() => normalizeCapabilities(m, "arc-manifest.yaml")).not.toThrow();
  });

  test("no-op when network absent or empty", () => {
    const m: ArcManifest = {
      name: "t",
      version: "1.0.0",
      type: "skill",
      capabilities: { bash: { allowed: false } },
    };
    normalizeCapabilities(m, "arc-manifest.yaml");
    expect(m.capabilities!.network).toBeUndefined();
  });

  test("throws on invalid entry type", () => {
    const m: ArcManifest = {
      name: "t",
      version: "1.0.0",
      type: "skill",
      capabilities: { network: [42] as any },
    };
    expect(() => normalizeCapabilities(m, "arc-manifest.yaml")).toThrow(
      /capabilities\.network entries must be/,
    );
  });

  test("warns on stderr when string shorthand present", () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as any;
    try {
      const m: ArcManifest = {
        name: "t",
        version: "1.0.0",
        type: "skill",
        capabilities: { network: ["github.com"] as any },
      };
      normalizeCapabilities(m, "arc-manifest.yaml");
    } finally {
      process.stderr.write = orig;
    }
    expect(captured.join("")).toContain("string shorthand");
    expect(captured.join("")).toContain("github.com");
  });

  test("no warning when all entries are object form", () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      captured.push(String(chunk));
      return true;
    }) as any;
    try {
      const m: ArcManifest = {
        name: "t",
        version: "1.0.0",
        type: "skill",
        capabilities: {
          network: [{ domain: "github.com", reason: "clone" }],
        },
      };
      normalizeCapabilities(m, "arc-manifest.yaml");
    } finally {
      process.stderr.write = orig;
    }
    expect(captured.join("")).toBe("");
  });
});

describe("readManifest — network shorthand (#79)", () => {
  test("string-form network entries parse into object form", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
    try {
      await Bun.write(
        join(tempDir, MANIFEST_FILENAME),
        `schema: arc/v1
name: shorthand-test
version: 0.1.0
type: skill
capabilities:
  network:
    - github.com
    - agentskills.io
`,
      );
      const manifest = await readManifest(tempDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.capabilities!.network).toEqual([
        { domain: "github.com", reason: "" },
        { domain: "agentskills.io", reason: "" },
      ]);
    } finally {
      process.stderr.write = orig;
    }
  });
});
