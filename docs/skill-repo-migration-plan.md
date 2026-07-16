# Skill Estate Migration — Detailed Execution Plan

**Companion to:** `docs/skill-repo-migration-spec.md` (the contract; this doc is the sequenced breakdown)
**Epic home:** the-metafactory/arc · **Date:** 2026-07-16
**Consumable by:** /plan-breakdown (each I-item below is one executor-grade sub-issue)

```
Phase 0        WS1 ──► WS2 ──►┬── WS3 ──┐
(epic setup)   standards CI    │         ├──► WS5 (fan-out, parallel) ──► WS6 ──► WS7
                               └── WS4 ──┘     one issue per repo         registry  close-out
D-track (human decisions) runs in parallel from day 1
```

---

## Phase 0 — Epic setup

**I0.1 — Open the epic** · repo: `arc`
Create epic issue "Skill estate migration — naming, manifests, registry" linking the spec; child-issue checklist mirroring this plan; label `epic`.
*Acceptance:* epic exists, spec committed (branch + PR to arc), all I-numbers filed as sub-issues linked to it.

---

## WS1 — Standards (compass) — gate for everything else

**I1.1 — Extend `standards/component-repo-naming.md`** · repo: `compass`
Add the `skill` class (`metafactory-skill-<name>`, `metafactory-<app>-skill-<name>`), the mechanical class-choice rule, and schedule every Category-A rename in the Migrations table (spec §3.1, §5.1). Fold in a pointer from the new-repo SOP pre-flight.
*Depends:* I0.1. *Acceptance:* PR merged; Migrations table rows exist with tracker links to the WS5 issues.

---

## WS2 — Manifest contract + validator

**I2.1 — Strict arc/v1 validator in arc** · repo: `arc`
Implement the normalized contract (spec §4.1) as a strict validation mode on top of `src/lib/manifest.ts`: required `schema: arc/v1`, singular `author`, mandatory `capabilities` block with explicit empties, network entries as `{host, reason}`, name-derivation rule (spec §4.2), optional `namespace` validated against `@scope` grammar only when present. Surface as `arc validate [path]` (or `--strict` on existing parse).
*Depends:* I1.1 (name rule references the ratified grammar). *Acceptance:* command exists; unit tests green.

**I2.2 — Fixture corpus** · repo: `arc`
One passing fixture per artifact type (skill, tool, agent, prompt, component, pipeline, action, bundle-style skill repo); one failing fixture per observed drift class: `pai/v1`, missing schema, `authors:` list, missing capabilities, repo/manifest name mismatch, legacy network shapes.
*Depends:* I2.1. *Acceptance:* validator red on every drift fixture, green on every passing fixture.

**I2.3 — Shared CI workflow** · repo: `metafactory-actions`
Reusable workflow `validate-manifest` invoking `arc validate`; adopted in a template skill-repo CI file.
*Depends:* I2.1. *Acceptance:* green on `metafactory-bundle-discord`; red on unmodified `plan-breakdown` manifest (proof run linked in the issue).

---

## WS3 — PackageBuilder consolidation (single source of truth)

**I3.1 — Mint `metafactory-skill-package-builder`** · repos: `metafactory-skill`, new repo
Extract the canonical PackageBuilder (`arc/skill/`, the 985-line SKILL.md + 4 workflows) into the new repo, absorbing the thin `metafactory-skill` repo (rename it — GitHub redirect preserved — and replace contents).
*Depends:* I1.1. *Acceptance:* new repo passes I2.3 CI; registered in `ecosystem/repos.yaml`.

**I3.2 — arc depends on it; delete `arc/skill/`** · repo: `arc`
Add `metafactory-skill-package-builder` to arc's `arc-manifest.yaml` `dependencies:`; remove `arc/skill/` in the same release (ADR-0024 D2 — no fallback copy); bump arc.
*Depends:* I3.1. *Acceptance:* `arc upgrade arc` lands the skill from the new repo; `arc/skill/` gone; PackageBuilder still invocable.

**I3.3 — PackageBuilder teaches the new conventions** · repo: `metafactory-skill-package-builder`
Rewrite SKILL.md conventions + CreatePackage workflow to scaffold the spec §4 layout, §4.1 manifest, §3.1 naming, and the namespace-is-not-identity rule.
*Depends:* I3.1. *Acceptance:* CreatePackage dry-run produces a repo skeleton that passes `arc validate`.

---

## WS4 — Pathfinder: `metafactory-soma-skill-handoff`

**I4.1 — Create the repo** · new repo
First repo born under the extended grammar. Layout per spec §4; skill design: deliberate, durable, recipient-addressed work-state transfer (CreateHandoff / ResumeHandoff workflows, drafts-only delivery, distinct from automatic compaction-survival). CI validator on from the first commit.
*Depends:* I1.1, I2.3. *Acceptance:* CI green; repo registered in `ecosystem/repos.yaml` with visibility set.

**I4.2 — End-to-end install proof** · repos: new repo, `test-rig`
`arc install` from the new repo on test-rig; verify skill lands in the substrate home as projection, CLI shims (if any) in `~/.local/bin`, clone under `~/.local/share/metafactory/arc/…` (XDG table, spec §3.2).
*Depends:* I4.1. *Acceptance:* round-trip documented in the issue; repo declared the WS5 template.

---

## WS5 — Bulk migration (fan-out; each issue independent once WS2+WS4 done)

Per-repo procedure (identical for I5.1–I5.5): GitHub rename → manifest normalize to §4.1 → cheap restructure to §4 layout (do NOT rewrite working tools) → org-wide consumer sweep for the old name → `ecosystem/repos.yaml` + registry update → `arc install`/`arc upgrade` round-trip on test-rig.
Per-repo acceptance: validator green; installs from new name; old-name redirect verified; org grep for old name returns only historical docs.

| Issue | Repo | Target | Extra work |
|---|---|---|---|
| **I5.1** | `arc-skill-code-review` | `metafactory-skill-code-review` | capabilities completion |
| **I5.2** | `pai-skill-sop` | `metafactory-skill-sop` | add schema, capabilities, author shape |
| **I5.3** | `plan-breakdown` | `metafactory-skill-plan-breakdown` | `pai/v1`→`arc/v1`; network shape |
| **I5.4** | `release-manager` | `metafactory-skill-release-manager` | `pai/v1`→`arc/v1`; capabilities; fix `ReleaseManager` name mismatch |
| **I5.5** | `distiller` | `metafactory-skill-distiller` | normalize |
| **I5.6** | `recall` | class decision first (skill vs app — it has a runtime), then migrate or just register | apply class-choice rule, record decision |
| **I5.7** | `content-filter` | class decision first (skill vs bundle), then migrate | apply class-choice rule, record decision |
| **I5.8** | `agent-state` | keep name (component, not skill-led) | manifest normalization only |

*Depends (all):* I2.3, I4.2. *Note:* I5.3 (plan-breakdown) should go LAST in this stream — it is the tool running the breakdown; don't rename it under our own feet mid-epic.

---

## WS6 — Registry unification

**I6.1 — Registry generator** · repo: `arc` (or `metafactory-actions`)
Generate `REGISTRY.yaml` from org scan + manifests (manifests are source of truth). Category B personal-org repos listed with real source + tier `community`.
*Depends:* majority of WS5 merged. *Acceptance:* regenerated registry matches reality (arc version correct — currently listed 0.12.1 vs actual 0.40.x); `arc search` / `arc source update` work against it.

**I6.2 — Retire `catalog.yaml`** · repo: `arc`
Confirm no resolution path reads it (`registry.ts`/`sources.ts` audit), then delete.
*Depends:* I6.1. *Acceptance:* file gone; install/search regression suite green.

**I6.3 — De-conflate trust vocabulary** · repos: `arc`, `meta-factory`
Registry entry `type:` field stops reusing manifest-`tier` words for source-trust; pick one vocabulary and rename the field or its values.
*Depends:* I6.1. *Acceptance:* registry schema documented; validator covers it.

---

## WS7 — Close-out

**I7.1 — XDG compliance sweep** — verify every migrated skill against the spec §3.2 table (no `~/bin`, no `~/.config/metafactory/pkg`, no dot-prefixed files in XDG dirs). *Depends:* WS5 complete.
**I7.2 — Archive superseded repos** — old `pai-skill-*` shells and any repo made redundant; archive, never delete. *Depends:* I6.1 (registry no longer points at them).
**I7.3 — Implementation-vs-spec review** — walk the spec's acceptance criteria + anti-criteria (especially Anti-1 consumer sweeps and Anti-2 cortex chain intact); update the compass Migrations table rows to Done. *Depends:* everything.

---

## D-track — Human decisions (parallel, non-blocking until WS6)

**ID.1 — Category B transfer proposals** — per-repo proposal to the owners (`mellanon/*`, `jcfischer/*` repos in the registry): transfer to org vs stay external-community. Decisions recorded on the issue; default is stay external.
**ID.2 — Category C shareable candidates** — principal decides which private `pai-skill-*` repos (if any) go public/org; the rest get manifest normalization only, under a personal `@scope` later.

---

## Summary

| Stream | Issues | Parallelizable | Gate |
|---|---|---|---|
| Phase 0 | 1 | — | none |
| WS1 standards | 1 | — | I0.1 |
| WS2 validator | 3 | I2.2/I2.3 after I2.1 | I1.1 |
| WS3 PackageBuilder | 3 | with WS4 | I1.1 |
| WS4 pathfinder | 2 | with WS3 | I1.1, I2.3 |
| WS5 migration | 8 | fully, except I5.3 last | I2.3, I4.2 |
| WS6 registry | 3 | sequential | WS5 majority |
| WS7 close-out | 3 | I7.1/I7.2 parallel | WS5/WS6 |
| D-track | 2 | fully | none |
| **Total** | **26 sub-issues** | | |
