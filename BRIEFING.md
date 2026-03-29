# arc Security & Lifecycle Briefing

> For @jcfischer and @Steffen025 — review request context

**Date:** 2026-03-18
**Author:** @mellanon (Luna)
**Review issue:** [pai-collab#106](https://github.com/mellanon/pai-collab/issues/106)

---

## TL;DR

PAI needs a way for users to share skills like `npm install` or `apt install`. We've done extensive research and discovered that **the firewall already exists** — PAI's `SecurityValidator.hook.ts` intercepts every tool call with YAML-based policies in <10ms. We just need to extend it to be skill-aware. This briefing explains what we built, what we found, and what we need your eyes on.

---

## What We Did (2026-03-18)

| Activity | Scope | Output |
|----------|-------|--------|
| 14 parallel research agents | npm attacks, MCP Registry, AAIF, Sigstore, plugin stores, capability models, prompt injection | [RESEARCH.md](https://github.com/mellanon/pai-pkg/blob/main/RESEARCH.md) |
| 4-agent council debate (3 rounds) | Transport choice, governance model, enforcement, minimum viable system | Council findings in RESEARCH.md §5 |
| 8-agent red team (32 perspectives) | Supply chain attacks, trust failures, capability bypasses, social engineering | Red team findings in RESEARCH.md §6 |
| First-principles analysis | What is the actual enforcement boundary? | Discovery: SecurityValidator IS the firewall |
| Security architecture design | Runtime enforcement, observability, integration | [SECURITY-ARCHITECTURE.md](https://github.com/mellanon/pai-pkg/blob/main/SECURITY-ARCHITECTURE.md) |
| Skill lifecycle design | End-to-end: author → package → install → enforce → upgrade → govern | [SKILL-LIFECYCLE.md](https://github.com/mellanon/pai-pkg/blob/main/SKILL-LIFECYCLE.md) |
| Analyzed 3 external sources | "Gas Town/Citadel", "Anthropic Attack", AvaKill | Integrated into architecture |

---

## Key Findings

### 1. The Firewall Already Exists

`SecurityValidator.hook.ts` is a `PreToolUse` hook that:
- Intercepts every `Bash`, `Read`, `Write`, `Edit` tool call
- Evaluates YAML patterns (`patterns.yaml`) against arguments
- Returns `block` / `ask` / `alert` / `allow` in <10ms
- Logs security events to `MEMORY/SECURITY/`

**What it lacks:** skill-scoped policies. It enforces global rules but doesn't know about installed skills' capability declarations.

**What we propose:** Extend `patterns.yaml` with a `skills:` section. When `arc install` runs, it reads the skill's `pai-manifest.yaml` and merges capabilities into `patterns.yaml`. When `arc disable` runs, it removes them. The hook stays global — no runtime skill attribution needed.

### 2. Signing Proves WHO, Not WHETHER SAFE

86% of malware droppers are digitally signed. The red team found 5 attack scenarios that would pass SkillSeal verification AND human review (subtle prompt injection in SKILL.md, confused deputy via composition, dependency confusion, typosquatting, helpful-looking skills that exfiltrate). Signing is necessary but not sufficient — runtime enforcement is the critical layer.

### 3. Council Shifted the Design

| Original Design | Council Consensus |
|----------------|------------------|
| 3 tiers (Official/Community/Universe) | 2 tiers (Built-in + Community) — ecosystem too small for three |
| npm as transport | Git-based — skills are repos, not library packages |
| Capability declarations as documentation | Capability declarations as enforceable policy |
| SkillSeal signing required | Signing recommended, git commit hash sufficient for Phase 1 |

### 4. Drip-Feed Attacks Need Observability

The "Anthropic Attack" blog describes attacks where individually-benign operations compose into an attack:
- Read config → summarize endpoints → write test → run test (exfiltrates via staging endpoint)

A `PostToolUse` SessionAudit hook with behavioral anomaly rules (sequence detection, count-based detection) addresses this. Individual event logging exists today; cross-event analysis is the gap.

### 5. Your Projects Are the Security Stack

| Your Project | Role in the Stack | Integration Proposal |
|-------------|------------------|---------------------|
| **pai-secret-scanning** (@jcfischer) | Layer 1: Outbound protection | `arc install --system pai-secret-scanning` |
| **pai-content-filter** (@jcfischer) | Layer 3: Inbound protection | `arc install --system pai-content-filter` |
| **skill-enforcer** (@jcfischer) | Skill structure validation | `arc install --system skill-enforcer` |

The `--system` flag distinguishes infrastructure packages from regular skills. System packages can't be casually disabled, are verified against the hive's allowed-signers, and provide patterns/rules consumed by SecurityValidator rather than SKILL.md instructions.

---

## The 7-Layer Enforcement Stack

```
Layer 6: GOVERNANCE        — pai-collab reviews, trust zones, SOPs
Layer 5: OBSERVABILITY     — SessionAudit hook, behavioral anomaly detection
Layer 4: RUNTIME ENFORCE   — SecurityValidator + skill-scoped patterns.yaml
Layer 3: INBOUND PROTECT   — pai-content-filter (34 patterns, 389 tests)
Layer 2: INSTALL VERIFY    — arc (signature check, capability display, user approval)
Layer 1: OUTBOUND PROTECT  — pai-secret-scanning (8 gitleaks rules)
Layer 0: IDENTITY          — Ed25519 signing + SkillSeal
```

### Arbor Patterns (Reference, Not Dependency)

The design adapts Arbor's security kernel patterns without requiring Arbor to run:

| Arbor | PAI Equivalent |
|-------|---------------|
| Resource URI (`arbor://fs/read/{path}`) | patterns.yaml path patterns |
| Capability store (ETS) | patterns.yaml `skills:` section |
| Reflex system | Claude Code hooks |
| Taint tracking | pai-content-filter quarantine |
| Trust-capability sync | `arc install` generates policy from manifest |

---

## What We Need From You

### @jcfischer — Integration & Packaging

1. **System package design**: How should pai-content-filter, pai-secret-scanning, and skill-enforcer be wrapped as `--system` packages? They install hooks + patterns, not SKILL.md files. What's the manifest schema for that?

2. **SecurityValidator extension**: The proposed `patterns.yaml` v2.0 schema adds `skills:` sections. Does this conflict with or complement the existing SecurityValidator patterns you've shipped?

3. **pai-content-filter as inbound gate**: The design proposes content filter patterns run BEFORE SecurityValidator on inbound content. Is the current hook ordering in `settings.json` correct for this?

4. **Anomaly detection**: Does pai-content-filter's fail-open + audit trail pattern apply to SessionAudit? Should anomaly rules use the same YAML format as content filter patterns?

### @Steffen025 — Adversarial Analysis

1. **Layer stack review**: Does the 7-layer model have gaps? Your previous reviews identified "Layer 2 described but not implemented" — the SECURITY-ARCHITECTURE.md addresses this. Is it sufficient?

2. **Composition trust**: Two skills with individually-safe capabilities can compose into a dangerous capability (network + file write = download-and-write). The `arc audit` command warns about this at install time. Is install-time warning enough, or do we need runtime composition tracking?

3. **Drip-feed detection**: The anomaly rule format (sequence triggers, count triggers, time windows) — are there attack patterns we're missing? Your CaMeL review expertise is relevant here.

4. **Key compromise**: Your previous review flagged "old signatures remain valid forever" in the hive protocol. How does this apply to skill signing? If an author's key is compromised, how do we revoke trust for all their published skills?

---

## Documents to Review

| Document | Words | Focus |
|----------|-------|-------|
| [SECURITY-ARCHITECTURE.md](https://github.com/mellanon/pai-pkg/blob/main/SECURITY-ARCHITECTURE.md) | 4,158 | Runtime enforcement, observability, integration |
| [SKILL-LIFECYCLE.md](https://github.com/mellanon/pai-pkg/blob/main/SKILL-LIFECYCLE.md) | 3,800+ | End-to-end lifecycle, how all layers compose |
| [RESEARCH.md](https://github.com/mellanon/pai-pkg/blob/main/RESEARCH.md) | 5,390 | Landscape, council, red team |
| [DESIGN.md](https://github.com/mellanon/pai-pkg/blob/main/DESIGN.md) | 3,500+ | Transport, trust, governance (existing, reviewed previously) |

**Priority:** SECURITY-ARCHITECTURE.md is the most critical for security review. SKILL-LIFECYCLE.md shows how everything composes. RESEARCH.md provides supporting evidence.

---

## How to Submit Your Review

1. **Quick feedback**: Comment on [pai-collab#106](https://github.com/mellanon/pai-collab/issues/106)
2. **Detailed review**: PR to `pai-collab/projects/arc/reviews/` following the [review format SOP](https://github.com/mellanon/pai-collab/blob/main/sops/review-format.md)
3. **Direct discussion**: Reply to the issue with questions — happy to clarify any design decisions

Thank you both. Your security expertise is what makes this system trustworthy.

— Andreas (@mellanon)
