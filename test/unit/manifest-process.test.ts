/**
 * Process-manifest validation tests (dev-loop F-6d, meta-factory#550).
 *
 * The schema here DESCRIBES pulse's real process vocabulary — an ordered
 * `actions:` array of steps that are either a bare string (deterministic
 * action ref), an `agent:` map (agentic step), or a `gate:` map (human gate).
 * It is NOT the idealised explicit-DAG (`nodes`/`startNode`/`endNodes`/
 * `dependsOn`) sketched in the issue body; that shape does not round-trip a
 * real pulse pipeline. See design/dev-loop-process-schema.md (meta-factory)
 * and the PR notes for the spec-vs-reality divergence.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readManifest, MANIFEST_FILENAME } from "../../src/lib/manifest.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-process-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write an arc-manifest.yaml into the temp dir and read it back. */
async function writeAndRead(yaml: string): Promise<ArcManifest | null> {
  await Bun.write(join(tempDir, MANIFEST_FILENAME), yaml);
  return readManifest(tempDir);
}

describe("process manifest — valid", () => {
  test("parses a minimal D/A/H process (pulse `actions:` vocabulary)", async () => {
    const manifest = await writeAndRead(`name: test-process
version: 1.0.0
type: process
process:
  name: P_TEST
  actions:
    - A_BUILD
    - agent:
        name: review
        capability: code-review.typescript
        prompt: "Review the diff."
    - gate:
        name: approve
        prompt: "Ship it?"
`);
    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe("process");
    expect(manifest!.process!.actions).toHaveLength(3);
    // Bare string = deterministic action ref.
    expect(manifest!.process!.actions[0]).toBe("A_BUILD");
  });

  test("accepts agent step optional fields (sovereignty, federate, timeout_ms, collect)", async () => {
    const manifest = await writeAndRead(`name: fed-process
version: 0.1.0
type: process
process:
  name: P_FED
  actions:
    - agent:
        name: perspective
        capability: ecosystem.perspective
        prompt: "Add your view."
        federate:
          principal: andreas
          stack: meta-factory
        sovereignty:
          classification: federated
          frontier_ok: true
        timeout_ms: 300000
        collect: perspective
`);
    expect(manifest).not.toBeNull();
    expect(manifest!.process!.actions).toHaveLength(1);
  });

  test("does not require `capabilities` for a process manifest", async () => {
    // Process manifests declare their needs per-node; the top-level
    // `capabilities` block is optional (like component/rules/agent).
    const manifest = await writeAndRead(`name: no-caps
version: 1.0.0
type: process
process:
  name: P_NOCAPS
  actions:
    - A_ONLY
`);
    expect(manifest).not.toBeNull();
    expect(manifest!.capabilities).toBeUndefined();
  });
});

describe("process manifest — invalid", () => {
  test("rejects a process with no `process` block", async () => {
    await expect(
      writeAndRead(`name: bad
version: 1.0.0
type: process
`),
    ).rejects.toThrow(/process/i);
  });

  test("rejects an empty `actions` array", async () => {
    await expect(
      writeAndRead(`name: empty
version: 1.0.0
type: process
process:
  name: P_EMPTY
  actions: []
`),
    ).rejects.toThrow(/non-empty|at least one/i);
  });

  test("rejects an agent step missing `capability`", async () => {
    await expect(
      writeAndRead(`name: bad-agent
version: 1.0.0
type: process
process:
  name: P_BADAGENT
  actions:
    - agent:
        name: act
        prompt: "do it"
`),
    ).rejects.toThrow(/capability/i);
  });

  test("rejects an agent step missing `prompt`", async () => {
    await expect(
      writeAndRead(`name: bad-agent2
version: 1.0.0
type: process
process:
  name: P_BADAGENT2
  actions:
    - agent:
        name: act
        capability: dev.implement
`),
    ).rejects.toThrow(/prompt/i);
  });

  test("rejects a gate step missing `prompt`", async () => {
    await expect(
      writeAndRead(`name: bad-gate
version: 1.0.0
type: process
process:
  name: P_BADGATE
  actions:
    - gate:
        name: approve
`),
    ).rejects.toThrow(/prompt/i);
  });

  test("rejects a step that is neither a string nor a known keyword map", async () => {
    await expect(
      writeAndRead(`name: bad-step
version: 1.0.0
type: process
process:
  name: P_BADSTEP
  actions:
    - frobnicate:
        name: huh
`),
    ).rejects.toThrow(/unknown step|frobnicate|string or/i);
  });

  test("rejects a non-positive agent timeout_ms", async () => {
    await expect(
      writeAndRead(`name: bad-timeout
version: 1.0.0
type: process
process:
  name: P_BADTIMEOUT
  actions:
    - agent:
        name: act
        capability: dev.implement
        prompt: "do it"
        timeout_ms: 0
`),
    ).rejects.toThrow(/timeout_ms/i);
  });
});

describe("process manifest — round-trips a real pulse pipeline", () => {
  // P_BUILD_JOURNAL, the canonical cross-principal pulse pipeline
  // (the-metafactory/pulse examples/build-journal/pipeline.yaml): D actions,
  // an `agent:` draft, a federated `agent:` perspective, an `gate:` editor
  // approval, then more D actions. Validates as type: process unchanged.
  test("P_BUILD_JOURNAL validates as a process", async () => {
    const manifest = await writeAndRead(`name: dev-loop
version: 0.1.0
type: process
process:
  name: P_BUILD_JOURNAL
  description: Cross-principal build journal.
  actions:
    - A_GATHER_FACTS
    - agent:
        name: draft
        capability: ecosystem.narrative
        prompt: "Turn this week's activity into a build-journal draft.\\n{facts}"
        sovereignty:
          classification: public
          frontier_ok: true
          model_class: any
        timeout_ms: 300000
        collect: draft
    - agent:
        name: perspective
        capability: ecosystem.perspective
        prompt: "Add your perspective.\\n{draft.output}"
        federate:
          principal: andreas
          stack: meta-factory
        sovereignty:
          classification: federated
          frontier_ok: true
          model_class: any
          max_hop: 1
        timeout_ms: 300000
        collect: perspective
    - gate:
        name: editor-approval
        prompt: "Publish to Discord + build log?"
        collect: approval
    - A_FORMAT_JOURNAL
    - A_POST_DISCORD
    - A_WRITE_BUILDLOG
    - A_DEPLOY_SITE
`);
    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe("process");
    const actions = manifest!.process!.actions;
    expect(actions).toHaveLength(8);
    // 5 deterministic string steps, 2 agent steps, 1 gate step.
    expect(actions.filter((s) => typeof s === "string")).toHaveLength(5);
    expect(
      actions.filter((s) => typeof s === "object" && s !== null && "agent" in s),
    ).toHaveLength(2);
    expect(
      actions.filter((s) => typeof s === "object" && s !== null && "gate" in s),
    ).toHaveLength(1);
  });
});
