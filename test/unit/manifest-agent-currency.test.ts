// arc#244 S2 (cortex#1133 arc lane) — `type: agent` manifest-validation currency.
//
// PURPOSE: pin that arc's manifest validation ACCEPTS a *current* cortex
// bot-pack's `arc-manifest.yaml` unchanged. The agent.yaml identity fragment is
// symlinked VERBATIM into the cortex stack's `agents.d/<id>.yaml`, and cortex
// validates its own AgentSchema (`runtime.{mode,capabilities,brain}`, guardrails,
// state, …) on hot-reload. arc's job at the package layer is therefore NOT to
// re-validate the agent's runtime semantics — it must TOLERATE / pass them
// through. A future tightening of arc's manifest schema that started rejecting a
// field cortex relies on would silently break every bot-pack install; these
// regression fixtures are the tripwire.
//
// The fixtures below are faithful (lightly trimmed) copies of the real reference
// bot-packs flagged in the issue:
//   - the-metafactory/yarrow            (single agent, standalone shape)
//   - the-metafactory/dev-loop          (a `type: library` bundle of agents)
//     · agents/dev      (in-process, capabilities: [dev.implement, …])
//     · agents/pilot    (multi-target [cortex, darwin-launchd], standalone)
//     · agents/approver (in-process, merge.approve)
//     · agents/release  (in-process, release.cut)
//
// They intentionally exercise every field the issue calls out as a rejection
// risk: `runtime.brain` (exec brain), `runtime.mode`, `runtime.capabilities` as
// a list, `lifecycle.postinstall`, multi-target `targets`, plus the bot-pack
// extras arc does not model in `ArcManifest` (guardrails / state / installScope /
// identity.channels / persona) — all of which must pass through, not throw.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readManifest, MANIFEST_FILENAME } from "../../src/lib/manifest.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-agent-currency-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Reference fixtures ─────────────────────────────────────────────────────

// the-metafactory/yarrow @ v0.3.0 — the FIRST cortex bot pack. Single agent,
// standalone shape: lifecycle.postinstall (reload + creds), top-level
// `dependencies` array, `authors` as a string array.
const YARROW = `name: "Yarrow"
version: "0.3.0"
type: agent
tier: community
description: "Yarrow — Pulse Composer. The first cortex bot pack."
authors:
  - "Jens-Christian Fischer"
repository: "the-metafactory/yarrow"

targets:
  - cortex

lifecycle:
  postinstall:
    - scripts/signal-cortex-reload.sh
    - scripts/issue-nats-creds.sh

dependencies:
  - name: "pulse"
    version: ">=0.15.0"
`;

// dev-loop agents/dev — in-process bot-pack. runtime.capabilities as a list,
// identity.channels.github, persona.file, lifecycle.postinstall (script path),
// guardrails, state, installScope.
const DEVLOOP_DEV = `schema: pai/v1
type: agent
namespace: metafactory
name: dev-loop-dev
version: 0.1.0
tier: custom
description: "The dev.implement consumer."

author:
  name: andreas
  github: aastroem

targets: [cortex]

runtime:
  substrate: claude-code
  mode: in-process
  capabilities:
    - dev.implement
    - code-review.typescript

identity:
  id: dev
  displayName: Dev
  shortName: dev
  oneLine: "dev.implement — worktree, CC session, gates, PR"
  channels:
    github:
      login: "\${DEV_GITHUB_LOGIN}"
      patEnv: "DEV_GITHUB_TOKEN"
      patScope: ["repo"]

persona:
  file: persona.md

lifecycle:
  postinstall:
    - scripts/reload-cortex.sh

guardrails:
  allowedDirs:
    - "~/work/"
    - "~/Developer/"
  disallowedTools:
    - WebFetch
    - WebSearch
  bashAllowlist:
    rules:
      - pattern: "^git\\\\s+(status|diff)(\\\\s|$)"

state:
  blueprint: agent-state
  version: ">=0.1.0"
  workItemKinds:
    - implement
    - fix-cycle

installScope: per-host
`;

// dev-loop agents/pilot — MULTI-TARGET [cortex, darwin-launchd] standalone bot.
// runtime.capabilities: [] (empty list), provides.{binary,plist}, triggers,
// hooks, roster, mentionRole — the densest bot-pack manifest.
const DEVLOOP_PILOT = `schema: pai/v1
type: agent
namespace: metafactory
name: dev-loop-pilot
version: 0.1.0
tier: custom
description: "The dev-loop loop-driver."

author:
  name: andreas
  github: aastroem

targets: [cortex, darwin-launchd]

runtime:
  substrate: cortex
  mode: standalone
  capabilities: []

identity:
  displayName: Pilot
  shortName: pilot
  oneLine: "Loop-driver"
  channels:
    discord:
      botId: "\${PILOT_DISCORD_BOT_ID}"
      tokenEnv: "PILOT_DISCORD_TOKEN"
      preferredChannels: ["dev-loop", "cortex"]
    github:
      login: "\${PILOT_GITHUB_LOGIN}"
      patEnv: "PILOT_GITHUB_TOKEN"
      patScope: ["repo", "read:org"]

persona:
  file: persona.md

guardrails:
  allowedDirs:
    - "~/work/"
  readOnlyDirs:
    - "~/.config/cortex/"
  disallowedTools:
    - WebFetch

triggers:
  - type: mention
    surface: discord
  - type: cron
    schedule: "*/10 * * * *"
    command: pilot tick
  - type: cron
    schedule: "@reboot"
    command: pilot watch

hooks:
  onStart: scripts/on-start.sh
  onError: scripts/on-error.sh

roster:
  - name: echo
    role: reviewer

state:
  blueprint: agent-state
  version: ">=0.1.0"
  workItemKinds:
    - feature-claim
    - release

installScope: per-host
mentionRole: dev-loop-pilot

provides:
  binary: scripts/pilot-daemon.sh
  plist: scripts/ai.meta-factory.dev-loop.pilot.plist
`;

// A forward-currency fixture: cortex's AgentSchema (cortex#962 CO-1 / #1021)
// admits an EXEC `runtime.brain` block (kind/run/protocol/lifecycle/secrets/
// maxRestarts/dispatch_capabilities) for standalone bots that carry their own
// brain process. The live dev-loop packs don't all carry one today, but the
// issue lists `runtime.brain` explicitly as a current-shape field arc must NOT
// reject. This pins that arc tolerates it (the fragment is symlinked verbatim;
// cortex owns brain semantics).
const AGENT_WITH_EXEC_BRAIN = `schema: pai/v1
type: agent
namespace: metafactory
name: dev-loop-brainy
version: 0.1.0
tier: custom
description: "A standalone bot-pack carrying an exec brain."

author:
  name: andreas
  github: aastroem

targets: [cortex, darwin-launchd]

runtime:
  substrate: custom-binary
  mode: standalone
  modelClass: frontier
  capabilities:
    - some.capability
  brain:
    kind: exec
    run: "./scripts/brain.sh"
    protocol: stdio-jsonl
    lifecycle: persistent
    secrets:
      - ANTHROPIC_API_KEY
    maxRestarts: 5
    dispatch_capabilities:
      - some.capability

identity:
  id: brainy
  displayName: Brainy

persona:
  file: persona.md

lifecycle:
  postinstall:
    - scripts/reload-cortex.sh

installScope: per-host
`;

// dev-loop ROOT — a `type: library` bundle. Member artifacts are the agents
// above. depends_on.packages, cortex_config pass-through. The root must NOT
// carry provides/capabilities/scripts/lifecycle (library-root rule) — and the
// real dev-loop root correctly carries none.
const DEVLOOP_LIBRARY_ROOT = `schema: pai/v1
type: library
namespace: metafactory
name: dev-loop
version: 0.1.0
tier: custom
description: "The agentic dev pipeline as an installable metafactory blueprint."

author:
  name: andreas
  github: aastroem

artifacts:
  - path: agents/pilot
    description: "type: agent — the loop-driver."
  - path: agents/dev
    description: "type: agent — the dev.implement consumer."
  - path: agents/approver
    description: "type: agent — the merge.approve gate."
  - path: agents/release
    description: "type: agent — the release.cut consumer."

depends_on:
  packages:
    - name: cortex
      repo: the-metafactory/cortex
    - name: pulse
      repo: the-metafactory/pulse
    - name: agent-state
      repo: the-metafactory/agent-state

cortex_config:
  path: process/cortex-config-fragment.yaml
`;

async function writeRootManifest(body: string): Promise<void> {
  await Bun.write(join(tempDir, MANIFEST_FILENAME), body);
}

// ── Single-agent bot-pack currency ─────────────────────────────────────────

describe("arc#244 S2 — type: agent bot-pack manifest currency", () => {
  test("accepts the yarrow single-agent bot-pack unchanged", async () => {
    await writeRootManifest(YARROW);
    const m = await readManifest(tempDir);
    expect(m).not.toBeNull();
    expect(m!.type).toBe("agent");
    expect(m!.targets).toEqual(["cortex"]);
    // lifecycle.postinstall is validated (relative script paths) — must pass.
    expect(m!.lifecycle?.postinstall).toEqual([
      "scripts/signal-cortex-reload.sh",
      "scripts/issue-nats-creds.sh",
    ]);
    // No capabilities block — agents are exempt; must not throw.
    expect(m!.capabilities).toBeUndefined();
  });

  test("accepts dev-loop agents/dev (in-process, runtime.capabilities list)", async () => {
    await writeRootManifest(DEVLOOP_DEV);
    const m = await readManifest(tempDir);
    expect(m).not.toBeNull();
    expect(m!.type).toBe("agent");
    expect(m!.runtime?.substrate).toBe("claude-code");
    expect(m!.runtime?.mode).toBe("in-process");
    expect(m!.runtime?.capabilities).toEqual([
      "dev.implement",
      "code-review.typescript",
    ]);
    expect(m!.identity?.id).toBe("dev");
    expect(m!.lifecycle?.postinstall).toEqual(["scripts/reload-cortex.sh"]);
  });

  test("accepts dev-loop agents/pilot (multi-target [cortex, darwin-launchd])", async () => {
    await writeRootManifest(DEVLOOP_PILOT);
    const m = await readManifest(tempDir);
    expect(m).not.toBeNull();
    expect(m!.targets).toEqual(["cortex", "darwin-launchd"]);
    expect(m!.runtime?.mode).toBe("standalone");
    // Empty capabilities list is legal (the dispatcher provides none).
    expect(m!.runtime?.capabilities).toEqual([]);
    expect(m!.provides?.binary).toBe("scripts/pilot-daemon.sh");
    expect(m!.provides?.plist).toBe(
      "scripts/ai.meta-factory.dev-loop.pilot.plist",
    );
  });

  test("accepts a standalone bot-pack carrying an exec runtime.brain", async () => {
    // Forward-currency: cortex's AgentSchema admits runtime.brain; arc must
    // tolerate it (the fragment is symlinked verbatim; cortex owns the schema).
    await writeRootManifest(AGENT_WITH_EXEC_BRAIN);
    const m = await readManifest(tempDir);
    expect(m).not.toBeNull();
    expect(m!.type).toBe("agent");
    // arc passes the brain block through untouched (it does not model it).
    const runtime = m!.runtime as Record<string, unknown> | undefined;
    expect(runtime).toBeDefined();
    const brain = runtime!.brain as Record<string, unknown>;
    expect(brain.kind).toBe("exec");
    expect(brain.run).toBe("./scripts/brain.sh");
    expect(brain.dispatch_capabilities).toEqual(["some.capability"]);
  });

  // Pass-through fields arc does NOT model in ArcManifest must survive parsing
  // (cortex validates them on reload). Read them off the parsed object.
  test("passes bot-pack-only fields (guardrails/state/installScope/persona) through untouched", async () => {
    await writeRootManifest(DEVLOOP_DEV);
    const m = await readManifest(tempDir);
    expect(m).not.toBeNull();
    const raw = m as unknown as Record<string, unknown>;
    expect(raw.guardrails).toBeDefined();
    expect((raw.state as Record<string, unknown>).blueprint).toBe("agent-state");
    expect(raw.installScope).toBe("per-host");
    expect((raw.persona as Record<string, unknown>).file).toBe("persona.md");
    // identity.channels carried verbatim (cortex resolves the env templates).
    const identity = raw.identity as Record<string, unknown>;
    expect(identity.channels).toBeDefined();
  });
});

// ── Library-bundle (fan-out source) currency ───────────────────────────────

describe("arc#244 S2 — type: library bundle root currency", () => {
  test("accepts the dev-loop library root unchanged", async () => {
    await writeRootManifest(DEVLOOP_LIBRARY_ROOT);
    const m = await readManifest(tempDir);
    expect(m).not.toBeNull();
    expect(m!.type).toBe("library");
    expect(m!.artifacts?.map((a) => a.path)).toEqual([
      "agents/pilot",
      "agents/dev",
      "agents/approver",
      "agents/release",
    ]);
    // depends_on.packages on the root is legal for a library bundle.
    expect(m!.depends_on?.packages?.length).toBe(3);
    // cortex_config is a pass-through (cortex validates it at merge time).
    expect((m as unknown as Record<string, unknown>).cortex_config).toBeDefined();
  });

  test("the full dev-loop bundle: every member agent manifest validates", async () => {
    // Lay down the library root + each member's arc-manifest.yaml, then walk
    // them exactly as a library install would (readManifest per artifact path).
    await writeRootManifest(DEVLOOP_LIBRARY_ROOT);
    const members: Record<string, string> = {
      "agents/dev": DEVLOOP_DEV,
      "agents/pilot": DEVLOOP_PILOT,
      "agents/approver": DEVLOOP_DEV.replace("dev-loop-dev", "dev-loop-approver")
        .replace("id: dev", "id: approver")
        .replace("dev.implement", "merge.approve"),
      "agents/release": DEVLOOP_DEV.replace("dev-loop-dev", "dev-loop-release")
        .replace("id: dev", "id: release")
        .replace("dev.implement", "release.cut"),
    };

    const root = await readManifest(tempDir);
    expect(root!.type).toBe("library");

    for (const [path, body] of Object.entries(members)) {
      await mkdir(join(tempDir, path), { recursive: true });
      await Bun.write(join(tempDir, path, MANIFEST_FILENAME), body);
    }

    // Every member must validate as a type: agent — this is the fan-out source.
    for (const path of root!.artifacts!.map((a) => a.path)) {
      const member = await readManifest(join(tempDir, path));
      expect(member, `member ${path} must validate`).not.toBeNull();
      expect(member!.type, `member ${path} is type: agent`).toBe("agent");
    }
  });
});
