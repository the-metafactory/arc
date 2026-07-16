# Skill Estate Migration — Epic Specification

**Status:** draft for review · **Epic home:** the-metafactory/arc · **Date:** 2026-07-16
**Input for:** /plan-breakdown (epic + executor-grade sub-issues)
**Provenance:** compass `standards/component-repo-naming.md` and `standards/xdg-base-directories.md`; cortex ADR-0017 (surface tooling bundles) + ADR-0024 (pluggable surface adapters); investigation of the live skill estate 2026-07-16.

---

## 1. Problem

Skills in the metafactory ecosystem are scattered across four naming eras (`pai-skill-*`, `arc-skill-*`, bare names, `metafactory-*`), two GitHub orgs plus personal accounts, and drifting manifest shapes (`pai/v1` vs `arc/v1` vs none; `author` vs `authors`; optional-in-practice `capabilities`). Discovery is bifurcated (hand-maintained `REGISTRY.yaml` — already stale, e.g. arc listed 0.12.1 vs actual 0.40.x — plus legacy `catalog.yaml`). The PackageBuilder skill has two diverging sources of truth (`arc/skill/` and `the-metafactory/metafactory-skill`).

The compass component-repo-naming standard is deliberately **prospective**: existing skill repos are grandfathered "unless a rename is separately scheduled" by "a concrete tracker". **This epic is that tracker.**

## 2. Principal decisions (fixed constraints, not open questions)

- **PD1 — Skills are separate repos in the `the-metafactory` org.** Not in-repo host skills, not a monorepo. Org littering is accepted and managed through naming (sorted grouping) and archiving.
- **PD2 — Delivery unit is the bundle-style repo**: one repo ships the skill *plus* the tools it uses, slash commands, agent rule files, hooks. One `arc-manifest.yaml` describes all of it via `provides:`.
- **PD3 — Keep it simple.** No soma-official skill tier, no host-contract second manifest, no contract-SDK sync in this epic. Those remain future options and nothing in this epic may preclude them, but nothing implements them either.
- **PD4 — Analysis first, then breakdown.** This spec is the analysis output; /plan-breakdown consumes it.

## 3. Naming standard (extends compass `component-repo-naming.md`)

### 3.1 Grammar

The existing ratified grammar is `metafactory-<owner>-<type>-<name>`, with cross-app tooling bundles using the literal `bundle` in the owner slot (`metafactory-bundle-<name>`). This epic adds one class, following the same construction:

```
metafactory-skill-<name>        # cross-app skill-led repo (the default for this epic)
metafactory-<app>-skill-<name>  # skill owned by / coupled to one app (e.g. metafactory-soma-skill-handoff)
metafactory-bundle-<name>       # unchanged: CLI-led or multi-skill cross-app collections (e.g. -bundle-discord)
```

Rules (inherited from the standard): lowercase hyphen-separated; `metafactory` always one word; every new repo registered in `compass/ecosystem/repos.yaml` per the new-repo SOP with `visibility` set; name is load-bearing (install dirs and registry entries derive from it).

**Class-choice rule (keep it mechanical):** if the repo's lead artifact is a SKILL.md (even when it ships tools/commands/rules that serve the skill) → `metafactory-skill-<name>`. If the lead artifact is a CLI or the repo carries multiple unrelated skills → `metafactory-bundle-<name>`. If the skill is inseparable from one app's runtime/CLI → `metafactory-<app>-skill-<name>`.

**Littering mitigation:** the prefix makes all skill repos sort adjacently in `gh repo list` and the registry; repos superseded or dead are **archived, not deleted** (GitHub archive keeps redirects and history without cluttering the active list when filtered by `archived:false`).

### 3.2 XDG relevance (answered)

XDG does **not** govern repo naming — it governs where installed artifacts land on disk. But the two standards are deliberate mirrors: the repo-naming grammar (brand → owner → type → name) was explicitly modeled on the cortex#1867 XDG suite-namespacing (`<xdg-base>/metafactory/<app>/…`). For this epic XDG is an **adopted constraint, not new design**:

| Class | Location | State |
|---|---|---|
| Skill repo clones (data) | `$XDG_DATA_HOME/metafactory/arc/…` (`~/.local/share/metafactory/arc/repos/`) | Already compliant — arc XDG P2 shipped (arc#287/#297, v0.39) |
| Installed CLI shims (bin) | `~/.local/bin` | Already compliant (arc#293/#295, XDG wave 3) |
| arc config (`sources.yaml`) | `$XDG_CONFIG_HOME/metafactory/…` | Compliant |
| Package index cache | `$XDG_CACHE_HOME/metafactory/…` | Verify during epic |
| Substrate homes (`~/.claude/skills/` etc.) | Substrate's own convention | **Exempt** — projection targets, never source of truth |

Epic obligation: each migrated skill passes an XDG compliance check (installs only into the classes above; no writes to `~/bin`, `~/.config/metafactory/pkg`, or dot-prefixed files inside XDG dirs).

## 4. Target repo shape (the bundle-style skill repo)

```
metafactory-skill-<name>/
  arc-manifest.yaml         # REQUIRED — the single manifest (schema: arc/v1)
  README.md                 # what it is, install one-liner, artifact inventory
  LICENSE                   # Apache-2.0 default (DD-13); AGPL only where already chosen
  skill/
    SKILL.md                # entrypoint: YAML frontmatter (PascalCase name) + routing table
    Workflows/              # one .md per discrete operation
    references/             # optional
  src/                      # tools used by the skill: bun-first TypeScript CLIs (src/cli.ts)
  commands/                 # slash-command .md prompt files
  agents/                   # agent rule files / subagent personas (.md)
  hooks/                    # hook scripts referenced by provides.hooks
  test/
  agents-md.yaml + CLAUDE.md  # generated via compass template
  blueprint.yaml            # if registered in compass/ecosystem/repos.yaml
```

Empty directories are omitted — a procedure-only skill is just `arc-manifest.yaml` + `skill/`.

### 4.1 Manifest contract (arc/v1, normalized)

One schema, machine-enforced. Required fields and canonical shapes (resolving current drift):

```yaml
schema: arc/v1                      # REQUIRED literal; pai/v1 and absent are migration failures
name: <repo-name-minus-prefix>      # lowercase-hyphenated; MUST derive from repo name (see 4.2)
# namespace: <@scope>               # OPTIONAL — see "Namespace is not identity" below
version: <semver, from 0.1.0>
type: skill | tool | agent | prompt | component | pipeline | action | rules | system | library | process  # an INSTALLABLE type (arc#334). NOT `bundle`: that is a repo-name class (metafactory-bundle-<name>), not a manifest type — the class-choice rule maps a bundle-class repo to an installable type (skill/tool).
tier: official | community | custom # one vocabulary; registry stops reusing these words for trust
description: <one line>
license: Apache-2.0
author: { name: <full-name>, github: <username> }   # SINGULAR map is canonical; authors: list is rejected
provides:
  skill:    [{ name: <PascalCase>, path: skill/, trigger: <phrase> }]
  cli:      [{ command: "bun src/cli.ts", name: <cmd> }]        # if src/ exists
  commands: [{ source: commands/<x>.md, target: <slash-name> }] # slash commands
  agents:   [{ source: agents/<x>.md }]
  hooks:    [{ event: <event>, command: <path> }]
capabilities:                        # REQUIRED block, explicit empties — never omitted
  filesystem: { read: [], write: [] }
  network: []                        # canonical entry shape: { host: <host>, reason: <why> }
  bash: { allowed: false }
  secrets: []
depends_on:
  tools: [{ name: bun }]
bundle:
  exclude: [vendor, MEMORY, node_modules, .git, Plans, test]
```

Notes:
- `provides.commands` / `provides.agents` may map onto the existing generic `provides.files` mechanism in arc if adding first-class keys is disproportionate — the sub-issue decides implementation, the spec fixes the *semantics* (a skill repo can declare slash commands and agent files and arc places them).
- The network capability entry shape is standardized on `host:` + `reason:` (currently three shapes exist in the wild).

**Namespace is not identity (applies to ALL metafactory artefacts — skills, bundles, blueprints, tools, agents, pipelines, actions):**

Two orthogonal axes must not be conflated:

1. **Provenance (who publishes)** — this is the ONLY namespace axis. The marketplace already designed it: DD-15 scoped namespaces (`@metafactory/<name>@<version>`), DD-113 org namespaces as registry-side *reservations* with no login, DD-114/F-171 delegation ACLs checked server-side at publish. A manifest cannot self-assert a namespace with any effect — the publishing account's delegation decides. arc today treats manifest `namespace` as exactly this: an optional publish-time scope hint (`src/types.ts:492`).
2. **Artifact class (what it is)** — carried by the manifest `type:` field and, for humans, by the repo-name `<type>` slot. Never by the namespace. Scopes are ownership; categories multiply (skill, bundle, blueprint, adapter, renderer, pipeline, action, persona, …) and putting them in scopes fragments the namespace and breaks "list everything `@metafactory` publishes".

Consequences for this epic:

- The universal artifact coordinate is `@scope/name@version` + manifest `type`. Filtering by class is a registry/CLI query (`arc search --type skill`), not a namespace segment. This one model covers blueprints, bundles, skills, and future classes with zero schema changes per new class.
- Manifest `namespace:` is **optional**; when present it must match the DD-15 `@scope` grammar and is only a publish-time default. Trust and install identity derive from the source URL + arc's install record (the ADR-0024 lesson: never key trust on author-controlled fields).
- Names are unique per scope, flat across types (the publish API shape `/@scope/<name>@<version>` has no type segment — aligned, and npm-proven). Same-concept different-class artifacts disambiguate by name (`dev-loop` vs `dev-loop-blueprint`), not by parallel namespaces.
- GitHub repo names (`metafactory-<owner>-<type>-<name>`) remain a human-sortability convention in a flat GitHub org — they are NOT the artifact coordinate and nothing may derive identity from them except the recorded source URL.
- Personal/private artefacts (Category C) publish under personal scopes (e.g. `@aastroem`) with no manifest changes — the same model scales from org to individual.

### 4.2 Name derivation rule

`repo name = metafactory-skill-<name>` ⇒ manifest `name: <name>`; SKILL.md frontmatter `name:` = PascalCase of `<name>`. No more `release-manager` repo / `ReleaseManager` manifest / arbitrary divergence. The validator enforces the mapping.

## 5. Migration inventory and dispositions

### 5.1 Category A — in-org skill repos: rename + normalize (core of the epic)

| Current repo | Target | Manifest work |
|---|---|---|
| `arc-skill-code-review` | `metafactory-skill-code-review` | normalize (arc/v1 already; capabilities partial) |
| `pai-skill-sop` | `metafactory-skill-sop` | add `schema:`, capabilities, author shape |
| `plan-breakdown` | `metafactory-skill-plan-breakdown` | `pai/v1` → `arc/v1`; network shape |
| `release-manager` | `metafactory-skill-release-manager` | `pai/v1` → `arc/v1`; add capabilities; fix name mismatch |
| `metafactory-skill` (PackageBuilder) | `metafactory-skill-package-builder` | see WS3 consolidation |
| `recall` | `metafactory-skill-recall` *or stays app* | decide: skill-led or app? (has runtime) |
| `distiller` | `metafactory-skill-distiller` | normalize |
| `content-filter` | `metafactory-skill-content-filter` *or bundle* | decide via class-choice rule |
| `agent-state` | keep (component, not skill-led) → registered as-is | normalize manifest only |
| `metafactory-bundle-discord` | keep (already standard) | none — reference implementation |

Every rename: GitHub rename (redirect preserved) → sweep all consumers' `depends_on`/install docs → update `compass/ecosystem/repos.yaml` key/url → update compass standard's migration table. The `metafactory-bundle-discord` rename (compass#116 / cortex#1905) is the proven playbook; reuse its checklist.

### 5.2 Category B — personal-org repos referenced by REGISTRY.yaml

`mellanon/pai-skill-doc`, `jcfischer/specflow-bundle`, `jcfischer/pii-pseudonymizer`, `mellanon/pai-agent-contributor`, `mellanon/pai-prompt-explain`, `mellanon/pai-tool-hello`.

Default disposition: **stay external, tier `community`**, listed in the regenerated registry with their real source. Transfer into the org only by explicit per-repo agreement with the owner (one sub-issue: propose the list, record decisions). No silent transfers.

### 5.3 Category C — private/personal `pai-skill-*` repos

confluence, coupa, jira, jira-analysis, gundog, docx, doc, context, dispatch, oncharging, upguard, claim-review, diagrams. Mostly personal/work-specific.

Disposition: **stay private**; migrate manifests to normalized arc/v1 so the same tooling/validator works; org-migrate only skills judged genuinely shareable (candidate list is a sub-issue for the principal — not decided here).

### 5.4 Category D — new skills born under the standard

`metafactory-soma-skill-handoff` is the **pathfinder**: the first repo created under the extended grammar, exercising scaffold → manifest → CI validator → registry → `arc install` end-to-end before bulk migration starts. Its skill design (deliberate, durable, recipient-addressed work-state transfer; CreateHandoff/ResumeHandoff workflows; drafts-only delivery; distinct from automatic compaction-survival) is already written and reviewed separately.

## 6. Work streams (the plan-breakdown axes)

### WS1 — Standards (compass)
1. PR to `standards/component-repo-naming.md`: add the `skill` class (grammar in §3.1), the class-choice rule, and schedule the Category-A renames in the Migrations table.
2. Confirm new-repo SOP covers skill repos (pre-flight naming line now has a concrete convention).

**Acceptance:** standard merged; migration table lists every Category-A rename with tracker links.

### WS2 — Manifest schema + validator
1. Write the normalized arc/v1 contract (§4.1) as a strict validator in arc (`src/lib/manifest.ts` already parses; add strict validation mode).
2. Shared CI check via `metafactory-actions` (reusable workflow: validate manifest, name-derivation rule, capabilities block, license present).
3. Fixture corpus: one passing fixture per artifact type; failing fixtures for each drift class found in the wild (pai/v1, authors-list, missing capabilities, name mismatch).

**Acceptance:** validator green on `metafactory-bundle-discord` and pathfinder; red on unmodified `plan-breakdown` manifest; wired into skill-repo CI template.

### WS3 — PackageBuilder consolidation (single source of truth)
1. Extract the canonical PackageBuilder (`arc/skill/`, 985-line SKILL.md) into `metafactory-skill-package-builder` (absorbing/renaming the thin `metafactory-skill` repo).
2. arc declares it as an arc-manifest dependency (the cortex↔adapter pattern); delete `arc/skill/` in the same release (ADR-0024 D2: no two sources of truth).
3. Update PackageBuilder content itself to teach the §3/§4 conventions (it currently teaches the old ones).

**Acceptance:** one PackageBuilder repo; `arc upgrade arc` lands it; old copy gone; its CreatePackage workflow scaffolds the §4 shape.

### WS4 — Pathfinder: `metafactory-soma-skill-handoff`
Create per §4 + the handoff skill design; register in repos.yaml; validator CI on from day one; `arc install` verified on test-rig.

**Acceptance:** installable end-to-end; serves as the template repo for WS5.

### WS5 — Bulk migration (Category A, one sub-issue per repo)
Per repo: rename → manifest normalize to §4.1 → restructure to §4 layout where cheap (do not rewrite working tools) → consumer sweep → repos.yaml + registry update → `arc install`/`arc upgrade` round-trip on test-rig.

**Acceptance per repo:** validator green; installs from new name; old name redirect verified; no consumer breaks (grep the org for the old name).

### WS6 — Registry unification
1. Generate `REGISTRY.yaml` from org scan + manifests (source of truth = manifests; the generator lives in arc or metafactory-actions).
2. Delete `catalog.yaml` (legacy PAI-era catalog) after confirming nothing resolves through it.
3. Fix trust-word conflation: registry `type:` field renamed or re-valued so manifest `tier` vocabulary isn't reused to mean source-trust.

**Acceptance:** regenerated registry matches reality (spot-check: arc version correct); `arc search`/`arc source update` work against it; catalog.yaml gone.

### WS7 — Close-out
XDG compliance sweep (§3.2 table) across migrated skills; archive superseded repos; implementation-vs-spec review.

**Sequencing:** WS1 → WS2 → (WS3 ∥ WS4) → WS5 → WS6 → WS7. WS5 sub-issues are independent and parallelizable once WS2+WS4 exist.

## 7. Anti-criteria

- **Anti-1:** No repo rename without the full consumer sweep + redirect verification (a rename is "a coordinated dependency-update, not a cosmetic change" — the standard's words).
- **Anti-2:** `arc upgrade cortex` and the cortex adapter chain must never break during this epic (adapters are out of scope; they already follow their own standard).
- **Anti-3:** No writes into substrate homes as source of truth; `~/.claude/**` stays a projection target.
- **Anti-4:** No transfer of personal-org (Category B) or private (Category C) repos without explicit owner decision recorded on the sub-issue.
- **Anti-5:** No new manifest schema version, host-contract manifest, or soma skill tier in this epic (PD3) — the normalized arc/v1 must simply not preclude them.

## 8. Open items deliberately left to sub-issues

- `recall` and `content-filter` class decision (skill vs app/bundle) — apply the class-choice rule during their sub-issue.
- Category B transfer proposals (needs owner agreement).
- Category C shareable-candidate list (needs principal).
- Whether `provides.commands`/`provides.agents` become first-class manifest keys or `provides.files` sugar (WS2 implementation detail).
