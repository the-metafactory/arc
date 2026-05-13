/**
 * Tests for arc#140 P1 manifest schema additions:
 *
 *   - targets:                    HostId[] validation
 *   - lifecycle.{pre,post}install array validation
 *   - lifecycle.{pre,post}uninstall array validation
 *   - runtime / identity / provides.{binary,plist,systemdUnit} pass-through
 *
 * Behavioural tests for the actual install-time execution of lifecycle
 * arrays live in test/commands/lifecycle-hooks.test.ts and the P3 multi-
 * target dispatch tests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readManifest, MANIFEST_FILENAME } from "../../src/lib/manifest.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-i140-manifest-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeManifest(content: string): Promise<void> {
  await Bun.write(join(tempDir, MANIFEST_FILENAME), content);
}

const baseAgentManifest = `
name: example-agent
version: 0.1.0
type: agent
`;

describe("targets validation", () => {
  test("accepts a single known target", async () => {
    await writeManifest(
      `${baseAgentManifest}targets: [cortex]\n`,
    );
    const m = await readManifest(tempDir);
    expect(m!.targets).toEqual(["cortex"]);
  });

  test("accepts multi-target standalone-bot shape", async () => {
    await writeManifest(
      `${baseAgentManifest}targets: [cortex, darwin-launchd]\n`,
    );
    const m = await readManifest(tempDir);
    expect(m!.targets).toEqual(["cortex", "darwin-launchd"]);
  });

  test("rejects unknown target host", async () => {
    await writeManifest(
      `${baseAgentManifest}targets: [bogus-host]\n`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/unknown target host 'bogus-host'/);
  });

  test("rejects empty targets array", async () => {
    await writeManifest(
      `${baseAgentManifest}targets: []\n`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/'targets' is empty/);
  });

  test("rejects duplicate targets", async () => {
    await writeManifest(
      `${baseAgentManifest}targets: [cortex, cortex]\n`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/duplicate target 'cortex'/);
  });

  test("rejects non-array targets", async () => {
    await writeManifest(
      `${baseAgentManifest}targets: cortex\n`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/'targets' must be an array/);
  });

  test("targets absent is OK (existing single-host shape)", async () => {
    await writeManifest(baseAgentManifest);
    const m = await readManifest(tempDir);
    expect(m!.targets).toBeUndefined();
  });
});

describe("lifecycle validation", () => {
  test("accepts ordered postinstall array", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  postinstall:
    - scripts/signal-cortex-reload.sh
    - scripts/issue-nats-creds.sh
    - scripts/start-daemon.sh
`,
    );
    const m = await readManifest(tempDir);
    expect(m!.lifecycle?.postinstall).toEqual([
      "scripts/signal-cortex-reload.sh",
      "scripts/issue-nats-creds.sh",
      "scripts/start-daemon.sh",
    ]);
  });

  test("accepts all four phases", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  preinstall:    [scripts/check.sh]
  postinstall:   [scripts/post.sh]
  preuninstall:  [scripts/pre-un.sh]
  postuninstall: [scripts/post-un.sh]
`,
    );
    const m = await readManifest(tempDir);
    expect(m!.lifecycle?.preinstall).toEqual(["scripts/check.sh"]);
    expect(m!.lifecycle?.postinstall).toEqual(["scripts/post.sh"]);
    expect(m!.lifecycle?.preuninstall).toEqual(["scripts/pre-un.sh"]);
    expect(m!.lifecycle?.postuninstall).toEqual(["scripts/post-un.sh"]);
  });

  test("rejects unknown lifecycle phase", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  preinstallx: [scripts/x.sh]
`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/unknown lifecycle phase 'preinstallx'/);
  });

  test("rejects absolute paths", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  preinstall:
    - /etc/passwd
`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/must be a relative path/);
  });

  test("rejects '..' segments", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  preinstall:
    - ../escape.sh
`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/must not contain '\.\.'/);
  });

  test("rejects non-array phase value", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  preinstall: scripts/x.sh
`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/must be an array of script paths/);
  });

  test("rejects non-string entries", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  preinstall:
    - 42
`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/entries must be strings/);
  });

  test("lifecycle absent is OK", async () => {
    await writeManifest(baseAgentManifest);
    const m = await readManifest(tempDir);
    expect(m!.lifecycle).toBeUndefined();
  });

  test("empty phase array is OK (no-op at runtime)", async () => {
    await writeManifest(
      `${baseAgentManifest}lifecycle:
  postinstall: []
`,
    );
    const m = await readManifest(tempDir);
    expect(m!.lifecycle?.postinstall).toEqual([]);
  });
});

describe("library root manifest rejects lifecycle", () => {
  test("type:library with lifecycle fails", async () => {
    await writeManifest(
      `name: lib
version: 1.0.0
type: library
artifacts:
  - path: ./a
lifecycle:
  postinstall: [scripts/x.sh]
`,
    );
    await expect(readManifest(tempDir)).rejects.toThrow(/library root manifest must not contain 'lifecycle'/);
  });
});

describe("runtime / identity / provides.binary,plist,systemdUnit pass-through", () => {
  test("runtime + identity parse for standalone bot", async () => {
    await writeManifest(
      `${baseAgentManifest}runtime:
  substrate: pi-dev
  mode: standalone
  capabilities: [code-review, typescript]
identity:
  id: sage
  did: did:mf:sage
  displayName: Sage
  roles: [agent-restricted]
  trust: [luna, holly]
`,
    );
    const m = await readManifest(tempDir);
    expect(m!.runtime?.substrate).toBe("pi-dev");
    expect(m!.runtime?.mode).toBe("standalone");
    expect(m!.runtime?.capabilities).toEqual(["code-review", "typescript"]);
    expect(m!.identity?.id).toBe("sage");
    expect(m!.identity?.did).toBe("did:mf:sage");
    expect(m!.identity?.roles).toEqual(["agent-restricted"]);
    expect(m!.identity?.trust).toEqual(["luna", "holly"]);
  });

  test("provides.binary, plist, systemdUnit pass through", async () => {
    await writeManifest(
      `${baseAgentManifest}provides:
  binary: bin/sage-bot
  plist: services/ai.meta-factory.sage.plist
  systemdUnit: services/sage.service
`,
    );
    const m = await readManifest(tempDir);
    expect(m!.provides?.binary).toBe("bin/sage-bot");
    expect(m!.provides?.plist).toBe("services/ai.meta-factory.sage.plist");
    expect(m!.provides?.systemdUnit).toBe("services/sage.service");
  });
});
