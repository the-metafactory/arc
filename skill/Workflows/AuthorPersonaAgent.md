# AuthorPersonaAgent Workflow

> Walk an author end-to-end through composing a persona-driven agent on top of one or more existing skill bundles. The output is a `type: agent` arc package whose persona is a thin voice and routing file, and whose actual work is delegated to versioned skill bundles referenced by name.

## When to Use

Use this workflow when:

- You are creating a new agent (e.g. Forge, Distiller, Backlogger, ...) on top of skill bundles that already exist (or that you will author alongside).
- You are converting a hand-configured bot identity (e.g. a Grove `bot.yaml` entry) into a portable agent manifest.
- You need a composition reference: which existing skill bundles do I lean on, what genuinely new bundle do I need to author?

Do NOT use this workflow for:

- Authoring a single skill bundle without a persona on top -- use `CreatePackage.md` instead.
- Editing an existing agent's persona file (that is a normal source edit; no scaffolding needed).
- Defining the agent platform itself -- see `forge/design/agent-platform.md` for the manifest schema and host responsibilities.

The convention this workflow follows is documented in SKILL.md § 12 (Persona-Driven Agents). Read § 12 before starting; the four-layer split, the bundle/persona decoupling, and the conformance checklist are the rules this workflow enforces.

## Prerequisites

Before starting:

- [ ] You have read SKILL.md § 12 (Persona-Driven Agents) and the manifest schema in `forge/design/agent-platform.md`.
- [ ] You can name the agent and write a one-line description of what it does.
- [ ] You can identify at least one trigger surface (Discord mention, CLI subcommand, cron, webhook).
- [ ] You know which host(s) will instantiate the agent (Grove, pilot, ...). The manifest is host-agnostic, but knowing the target shapes the trigger and identity choices.

---

## Steps

### 1. Decide What's New vs. Reusable

**Action:** List every capability your agent needs. For each, decide: does an existing skill bundle already deliver it, or is it genuinely new domain logic?

Run `arc list --type skill` to see what is already available. Common reusable bundles:

| Bundle | What it provides |
|--------|------------------|
| `AgentState` | Per-instance errands queue, dashboard, retros, replay-on-restart. **Almost every persona-driven agent leans on this.** |
| `PackageBuilder` | Authoring conformant arc-installable packages. Useful for any agent that itself authors or publishes packages. |
| `BlueprintTracker` | Reading and updating `blueprint.yaml` feature graphs. Useful for any agent that drives feature work. |
| `CodeReview` | Multi-lens PR review. Useful for review-loop agents (Echo, Luna). |

If a capability is **already covered by an existing bundle**, list that bundle in your manifest's `blueprints[]`. Do not re-implement.

If a capability is **genuinely new domain logic** (e.g. ReleaseManager's bump/tag/bundle/publish/deploy/announce sequence is specific to the release domain), it gets its own skill bundle. Author it via `CreatePackage.md` first, then come back to this workflow.

**Verify:** You have a complete list of capabilities, each tagged either "existing bundle: `<name>`" or "new bundle: `<name>` (to author)".

**Anti-pattern:** Wrapping an existing bundle in a new bundle "just to add some persona-specific tweaks". Persona-specific judgment goes in the persona file (Step 4); shared procedure stays in the existing bundle (SKILL.md § 12.4).

### 2. Scaffold Any New Skill Bundle(s)

**Action:** For each new bundle identified in Step 1, run the `CreatePackage` workflow to scaffold and author it. Each new bundle is its own arc-installable repo (typically its own GitHub repo) with `type: skill`.

Each new bundle MUST follow the layout in SKILL.md § 12.3:

```
my-skill/
  arc-manifest.yaml           # type: skill, version 0.1.0
  skill/
    SKILL.md                   # entry point
    Workflows/                  # one MD per discrete operation
    scripts/                    # bun-runnable CLIs
  src/                          # if it also exposes library code
  tests/
  blueprint.yaml
  CLAUDE.md
```

Bundle, publish, and verify each new skill via `PublishBundle.md` BEFORE wiring it into the agent. The agent manifest pins specific versions; you cannot pin a version that does not exist in the registry yet.

**Verify:** Every bundle listed in your agent's `blueprints[]` is either already installable via `arc install <name>` or has been published in this step.

**Anti-pattern:** Authoring the agent manifest first and "filling in the bundles later". The manifest's `blueprints[]` versions need to resolve at install time; missing bundles break the install on a clean machine.

### 3. Write Workflow MDs in Each New Bundle

**Action:** For each new skill bundle, write one workflow MD per discrete operation in `skill/Workflows/`.

Every workflow MD follows the **Action / Verify / Anti-pattern** shape:

- **Action**: imperative steps the agent executes (with concrete commands, not prose)
- **Verify**: how the agent (or a reviewer) confirms the action succeeded -- specific, observable outcomes
- **Anti-pattern**: what NOT to do at this step, and why

Workflows reference scripts by **relative path from the skill root** so they are portable (e.g. `bun ./scripts/one-thing.ts --arg`). The host resolves the relative path against the bundle install location at runtime.

If a workflow mutates shared state outside the agent's instance dir (publishes to a registry, deploys to a host, merges a PR, bumps a shared config), make it **two-phase** per SKILL.md § 12.6: a Phase 1 dry-run workflow that ends at a halt prompt, and a Phase 2 commit workflow that refuses to run without Phase 1's output.

**Verify:** Every workflow file you reference in any persona's routing table (Step 4) actually exists and follows the Action/Verify/Anti-pattern shape.

**Anti-pattern:** Vague workflow steps ("handle errors appropriately", "make sure things look right"). Every Verify item must be a binary pass/fail check.

### 4. Write the Persona File

**Action:** Write `persona.md` in the agent bundle root. This is the agent's voice, judgment defaults, routing table, output rules, and hard rules.

**Cap the persona at ~200 lines** (conformance checklist § 12.7). Anything longer is doing the work of a skill bundle; extract it.

The persona file SHOULD include:

| Section | What goes here |
|---------|----------------|
| Identity | One paragraph: who is this agent, what does it do, why does it exist |
| Voice | How the agent speaks (terse vs verbose, formal vs casual, signature phrases) |
| Judgment defaults | Standing decisions the agent makes without re-asking (e.g. "always run dry-run before publish", "always cite the source design doc") |
| Routing table | Maps incoming request patterns to a workflow file in one of the listed `blueprints[]` |
| Output rules | What every response from this agent looks like (format, length, what to include / omit) |
| Hard rules | Things the agent never does, even when asked (e.g. "never publish without operator confirm") |

The persona file MUST NOT:

- Duplicate authority that lives in the manifest's `guardrails`. The manifest is the source of truth (SKILL.md § 12.5). Reference it ("you operate under the bashAllowlist declared in the manifest"); do not restate it.
- Reference workflows that are not in any `blueprints[]` listed in the manifest. Every routing-table entry must resolve.
- Embed scripts or executable logic. The persona is markdown that the agent reads; procedure lives in the skill bundle's workflows and scripts.

**The persona file ships in the agent bundle**, alongside `arc-manifest.yaml`. It does NOT ship in any skill bundle (SKILL.md § 12.2). The host copies it to `~/.config/<host>/personas/<name>.md` on install.

**Verify:** Persona is <= 200 lines. Every routing-table entry maps to an existing workflow in a listed bundle. No authority is restated in prose.

**Anti-pattern:** A 600-line persona that re-encodes everything the agent might do. That is not a persona; that is an unbundled skill. Extract it into a bundle.

### 5. Write the Agent Manifest

**Action:** Write `arc-manifest.yaml` at the agent bundle root with `type: agent` and the nine required fields per `forge/design/agent-platform.md` (lines 159-171): `type`, `tier`, `identity`, `persona.file`, `blueprints[]`, `guardrails`, `triggers[]`, `instanceStateSpec`, and `instantiation.scope`. `hooks` and `roster[]` are recommended (and the conformance checklist asserts `hooks.onStart` separately) but not required by the schema.

Skeleton (replace placeholders; full schema in the design doc):

```yaml
schema: pai/v1
type: agent
namespace: metafactory                  # or your GitHub username for community tier
name: <agent-name>
version: 0.1.0
tier: custom                            # custom | community | verified | official
author:
  name: <full-name>
  github: <github-username>

identity:
  displayName: <Display Name>
  shortName: <short-name>
  oneLine: <one-line description>
  channels:
    discord:
      botId: "<discord-bot-id>"          # if Discord-addressable
      preferredChannels: ["#<channel>"]
      dmEnabled: true|false
    github:
      login: <github-login>              # if GitHub-addressable
      patScope: ["repo:status"]

persona:
  file: persona.md

blueprints:
  - name: <bundle-name>
    version: ">=<min-version>"

guardrails:
  allowedDirs: []
  readOnlyDirs: []
  allowedSkills: [<list every bundle in blueprints[] above>]
  disallowedTools: []
  bashAllowlist:
    rules:
      - pattern: "^gh\\s+"
      - pattern: "^git\\s+"

triggers:
  - type: mention
    surface: discord
    channelPattern: "#<pattern>"

hooks:
  onStart: AgentState/ReplayPending
  onMessageAccepted: AgentState/EnqueueErrand
  onMessageReplied: AgentState/MarkAckPosted
  onError: AgentState/SnapshotError
  onShutdown: AgentState/MarkPendingForReplay

roster:
  - name: <sibling-agent-name>
    role: <role>

instanceStateSpec:
  blueprint: AgentState
  version: ">=0.1.0"

instantiation:
  scope: per-host                        # per-host | per-network | per-repo
```

`guardrails.allowedSkills` MUST list every bundle declared in `blueprints[]` and nothing else. Mismatches between the two are a host-side denial waiting to happen.

**Verify:** The manifest contains all nine required fields per `forge/design/agent-platform.md` (lines 159-171). `arc bundle --dry-run` (or whatever pre-publish validation arc grows under AP-102) does not error.

**Anti-pattern:** Inventing manifest fields not in the schema. Hosts read only the fields they understand; extra fields are silently dropped, and the operator gets surprised behavior. If the schema needs extending, that is a `forge/design/agent-platform.md` change first, not an in-manifest extension.

### 6. Wire the Agent Into the Host

**Action:** Make the agent reachable from the host(s) you target.

Today, before AP-104 lands the `grove install agent <manifest>` adapter, this is a hand-mapping step. Use the worked example in `forge/design/agent-platform.md` (Grove integration section) as the guide. The mapping table there shows which manifest field becomes which `bot.yaml` field.

Concretely for Grove (today, manual):

1. Add an entry to `discord[]` in `~/.config/grove/bot.yaml` with the Discord bot ID and token (token stays out of the manifest -- secrets are operator config).
2. Add a per-bot role under `discord[].roles[]` with the same `allowedSkills`, `allowedDirs`, `disallowedTools`, and `bashAllowlist` as the manifest's `guardrails`.
3. Set `personaFile` to point at the persona path on disk (see G-905 -- Grove already supports this).
4. If the agent will be addressable by other bots, add it to `trustedAgentBots` with the role binding.
5. Reload the config or restart grove-bot per the AP-104 watcher rules (existing identities hot-reload; brand-new Discord identities require restart).

When AP-104 lands, this step collapses to `grove install agent <bundle>`.

For pilot (today): register the agent's CLI subcommand and point pilot at the manifest path. AP-105 will land the equivalent `pilot install agent` flow.

**Verify:** From the host, send the agent a message via its declared trigger surface (Discord ping, CLI invocation, etc.). The agent responds in its persona voice. The response uses workflows from the listed bundles.

**Anti-pattern:** Granting the agent broader authority on the host than the manifest declares. If `guardrails.disallowedTools` lists `Edit` and `Write`, the host's role config MUST also disallow them. Silent widening is a privilege-escalation finding (DD-16).

### 7. Verify Conformance Against § 12.7

**Action:** Walk the conformance checklist in SKILL.md § 12.7. Every item must pass.

Re-paste it here for convenience; tick each:

- [ ] Persona file is <= 200 lines.
- [ ] Persona file ships in the agent bundle, not in any skill bundle.
- [ ] Manifest declares `type: agent` and includes all nine required fields per `forge/design/agent-platform.md`: `type`, `tier`, `identity`, `persona.file`, `blueprints[]`, `guardrails`, `triggers[]`, `instanceStateSpec`, `instantiation.scope`.
- [ ] Every entry in the persona's routing table maps to an existing workflow in one of the listed `blueprints[]`. No dangling references.
- [ ] No procedure is duplicated across two `blueprints[]`.
- [ ] No authority declared in the persona file that isn't also in `guardrails`.
- [ ] `instanceStateSpec.blueprint` is set.
- [ ] All `blueprints[]` entries resolve via `arc install` on a clean machine.
- [ ] `hooks.onStart` is set.
- [ ] Manifest passes `arc validate` (when AP-102 lands).

A failure on any item means the agent is not yet conformant. Fix the gap; do not publish until every item is green.

**Verify:** Every checkbox is ticked. Where a check is currently un-runnable (e.g. `arc validate` not yet implemented), record that explicitly so it is not silently dropped.

**Anti-pattern:** Publishing a non-conformant agent and "fixing it in the next version". A non-conformant agent in the registry teaches the next author bad shape; the convention only holds if every published agent honours it.

---

## Verification Checklist

After completing all steps:

- [ ] Step 1: capability list has been triaged into existing-bundle vs new-bundle
- [ ] Step 2: every new skill bundle exists, is published, and is installable on a clean machine
- [ ] Step 3: every workflow file the persona routes to exists and follows Action/Verify/Anti-pattern
- [ ] Step 4: persona file is <= 200 lines, lives in the agent bundle, restates no authority
- [ ] Step 5: agent manifest has all nine required fields per `forge/design/agent-platform.md` and is internally consistent (allowedSkills matches blueprints[])
- [ ] Step 6: host has been wired (or `grove install agent` has run, post-AP-104) and the agent responds to its declared trigger
- [ ] Step 7: § 12.7 conformance checklist is fully ticked

## What NOT To Do

- **Do not author the persona before the bundles exist.** The manifest must reference real, installable bundles; authoring top-down lands you with a manifest that does not resolve.
- **Do not duplicate procedure between persona and bundle.** Procedure lives in workflows; the persona routes to them. SKILL.md § 12.4.
- **Do not invent authority mechanisms in the persona.** Use host primitives via `guardrails`. SKILL.md § 12.5.
- **Do not ship the persona inside a skill bundle.** Personas ship in the agent bundle; skills are reusable across agents. SKILL.md § 12.2.
- **Do not skip the conformance checklist.** Every item is binary; every item matters. SKILL.md § 12.7.
- **Do not extend the manifest schema in your manifest file.** Schema changes go through the agent-platform design doc (`forge/design/agent-platform.md`) first.
