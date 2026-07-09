/**
 * arc#281 — manifest-level validation of the opt-in `state` field.
 *
 * `state: { blueprint, version }` opts a type:agent package into an instance-
 * state scaffold at install (stateless by default). This suite verifies the
 * loader accepts a well-formed opt-in, passes it through typed, tolerates its
 * absence (stateless), and rejects malformed shapes at read time with a clear
 * error (acceptance path (c) — "malformed state shape → clear validation error").
 *
 * Kept in a dedicated file (not manifest.test.ts) to avoid churn against the
 * concurrent PR #282 edits there.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readManifest, MANIFEST_FILENAME } from "../../src/lib/manifest.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-state-manifest-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write an agent manifest with the given `state:` YAML block (or none). */
async function writeAgentManifest(stateBlock: string): Promise<void> {
  await Bun.write(
    join(tempDir, MANIFEST_FILENAME),
    `name: scout\nversion: 1.0.0\ntype: agent\ntier: custom\n${stateBlock}`,
  );
}

describe("readManifest — agent state opt-in (arc#281)", () => {
  test("parses a well-formed state opt-in and types it through", async () => {
    await writeAgentManifest(`state:\n  blueprint: AgentState\n  version: ">=0.1.0"\n`);
    const manifest = await readManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.state).toEqual({ blueprint: "AgentState", version: ">=0.1.0" });
  });

  test("a stateless agent (no state field) is valid; state is undefined", async () => {
    await writeAgentManifest("");
    const manifest = await readManifest(tempDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.state).toBeUndefined();
  });

  test("rejects a bare `state:` key (YAML null — a half-declaration typo)", async () => {
    // `state:` with no value parses to null. It must NOT be treated as "absent"
    // (which would opt the agent into an empty scaffold via the presence gate).
    await writeAgentManifest(`state:\n`);
    await expect(readManifest(tempDir)).rejects.toThrow(
      "'state' is empty (a bare 'state:' key)",
    );
  });

  test("rejects state missing blueprint", async () => {
    await writeAgentManifest(`state:\n  version: ">=0.1.0"\n`);
    await expect(readManifest(tempDir)).rejects.toThrow("'state.blueprint' must be a non-empty string");
  });

  test("rejects state missing version", async () => {
    await writeAgentManifest(`state:\n  blueprint: AgentState\n`);
    await expect(readManifest(tempDir)).rejects.toThrow("'state.version' must be a non-empty string");
  });

  test("rejects empty-string subfields", async () => {
    await writeAgentManifest(`state:\n  blueprint: ""\n  version: ""\n`);
    await expect(readManifest(tempDir)).rejects.toThrow("'state.blueprint' must be a non-empty string");
  });

  test("rejects a non-object state (scalar)", async () => {
    await writeAgentManifest(`state: nope\n`);
    await expect(readManifest(tempDir)).rejects.toThrow(
      "'state' must be an object with 'blueprint' and 'version'",
    );
  });

  test("rejects a state array", async () => {
    await writeAgentManifest(`state:\n  - AgentState\n`);
    await expect(readManifest(tempDir)).rejects.toThrow("(got array)");
  });
});
