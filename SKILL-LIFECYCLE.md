# PAI Skill Lifecycle Architecture

> How skills are created, distributed, installed, enforced, upgraded, and governed — and how all the layers compose into one system.

**Status:** Design specification
**Scope:** End-to-end skill lifecycle from authoring to retirement, integrating all existing infrastructure
**Companion docs:** [DESIGN.md](DESIGN.md) (transport/trust/governance), [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) (runtime enforcement), [RESEARCH.md](RESEARCH.md) (landscape analysis)

---

## The Problem This Solves

PAI's skill ecosystem has grown organically into a set of disconnected systems:

| System | What It Does | Where It Lives |
|--------|-------------|----------------|
| PAI releases (v4.0.3) | Built-in skills (18 upstream) | Release tree (`~/.claude/skills/`) |
| Custom skill repos | 7 standalone skills (`pai-skill-*`) | `~/Developer/pai-skill-*/` |
| Three-tier persistence | Secrets, config, runtime state | `~/.config/arc/`, `pai-personal-data/` |
| SecurityValidator | Tool-call firewall (YAML policies) | `~/.claude/hooks/` |
| pai-content-filter | Prompt injection detection | `jcfischer/pai-content-filter` (spoke repo) |
| pai-secret-scanning | Outbound secret detection | `jcfischer/pai-secret-scanning` (spoke repo) |
| skill-enforcer | Skill structure validation | `jcfischer/pai-skill-enforcer` (spoke repo) |
| pai-collab | Governance, reviews, SOPs | `mellanon/pai-collab` (hub) |
| the-hive | Protocol specs for multi-operator sharing | `mellanon/the-hive` |
| Arbor | Reference security kernel (Elixir) | `~/Developer/arbor/` |

**No single document shows how these compose.** The migration plan (v3.0 → v4.0) documents the pain:
- PAI upgrades require manual symlink recreation and file copying
- Custom skills were lost during `cp -r` (symlinks dereferenced)
- Secrets stored as flat files inside the release tree were stranded
- No standard way to install, update, or remove third-party skills
- Security enforcement exists but isn't skill-aware

This document defines the unified lifecycle that connects all of these.

---

## 1. Skill Categories

| Category | Example | Managed By | Upgrade Path |
|----------|---------|-----------|-------------|
| **Built-in** | Research, Thinking, Media | PAI release | PAI version upgrade (symlink swap) |
| **Custom** | _JIRA, _COUPA, _CONTEXT | Standalone repo (`pai-skill-*`) | `git pull` in repo |
| **Community** | (future) Third-party skills | `arc install` | `arc update` |
| **System** | pai-content-filter, pai-secret-scanning | `arc install --system` | `arc update --system` |

All four categories converge on the same integration pattern: **symlinks from `~/.claude/skills/` into the skill's source directory.** The skill's actual files never live as flat copies in the release tree.

---

## 2. Lifecycle Phases

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌─────────┐
│  AUTHOR  │───→│ PACKAGE  │───→│  PUBLISH  │───→│ DISCOVER │───→│ INSTALL │
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └─────────┘
                                                                     │
     ┌──────────┐    ┌─────────┐    ┌──────────┐    ┌──────────┐    │
     │  RETIRE  │←───│ DISABLE │←───│  UPDATE  │←───│ ENFORCE  │←───┘
     └──────────┘    └─────────┘    └──────────┘    └──────────┘
```

Each phase maps to specific infrastructure:

| Phase | Infrastructure | What Happens |
|-------|---------------|-------------|
| **Author** | Git repo + skill/ + src/ | Developer creates SKILL.md, workflows, CLI tools |
| **Package** | pai-manifest.yaml + arc CLI | `arc init` scaffolds manifest; `arc sign` signs |
| **Publish** | Git registry + curated list | `arc publish` pushes to git; PR to curated list for Community tier |
| **Discover** | Curated list + `arc search` | Users browse/search available skills |
| **Install** | arc CLI + SecurityValidator | Verify → display caps → merge policy → symlink → record |
| **Enforce** | SecurityValidator + patterns.yaml | Every tool call evaluated against skill-scoped policies |
| **Update** | arc CLI | `arc update` re-verifies, re-merges policy |
| **Disable** | arc CLI | Remove policy, move to `.disabled/` |
| **Retire** | arc CLI + curated list | `arc remove`, destatement if malicious |

---

## 3. Authoring: The Standalone Skill Repo Pattern

Proven by the 7 custom skill extractions (2026-03-18). Every skill — built-in, custom, community — follows this structure:

```
pai-skill-{name}/
├── skill/                          # Symlinked as ~/.claude/skills/{Name}
│   ├── SKILL.md                    # Natural language instructions for the agent
│   ├── Workflows/                  # Workflow routing markdown files
│   │   └── *.md
│   ├── docs/                       # Reference documentation
│   ├── openspec/                   # OpenSpec declarations
│   └── EXTEND.yaml                 # User customization hooks (optional)
├── src/                            # CLI tool source (optional)
│   ├── {tool}.ts                   # Main CLI entry point
│   └── lib/                        # Library modules
├── pai-manifest.yaml               # Capability declarations (for arc)
├── package.json                    # Bun/npm dependencies
├── README.md
├── LICENSE
└── .gitignore                      # Excludes node_modules, secrets, .env
```

### pai-manifest.yaml (The Single Source of Truth)

```yaml
name: MySkill
version: 1.0.0
type: skill
author:
  name: username
  github: username

# What the skill provides
provides:
  skill:
    - trigger: "my skill"
    - trigger: "do the thing"
  cli:
    - command: "bun src/tool.ts"
      name: "mytool"

# What the skill requires from other skills
depends_on:
  skills:
    - name: Parser
      version: ">=1.0.0"
  tools:
    - name: bun
      version: ">=1.0.0"

# What the skill needs access to (enforced at runtime)
capabilities:
  filesystem:
    read:
      - "~/.claude/MEMORY/WORK/"
    write:
      - "~/.claude/MEMORY/WORK/"
  network:
    - domain: "api.example.com"
      reason: "API calls for data processing"
  bash:
    allowed: true
    restricted_to:
      - "bun src/tool.ts"
  secrets:
    - "MY_API_KEY"
  skills:
    - "Parser"
  mcp: []
  hooks: []
```

### Three-Tier Persistence for Skill Data

Skills that have configuration or state use the three-tier architecture. Nothing mutable lives as a flat file in the release tree or the skill repo.

```
Tier 1: Secrets (API tokens)
  ~/.config/arc/secrets/{skill-name}.env
  → Never in git. Survives all upgrades.

Tier 2: Instance config (URLs, project keys, usernames)
  ~/Developer/pai-personal-data/profiles/{skill-name}/
  → In private git. Survives all upgrades.

Tier 3: Runtime state (cache, rate limits, last-run)
  ~/.config/arc/skills/{skill-name}/
  → Not in git. Survives PAI upgrades. Disposable.
```

Symlinks bridge these into the skill's working directory:

```
~/.claude/skills/_JIRA/profiles/work.env
  → pai-personal-data/profiles/jira/work.env         (Tier 2)

~/.claude/secrets/jira-work.env
  → ~/.config/arc/secrets/jira-work.env               (Tier 1)
```

---

## 4. Installation: What Actually Happens

### 4.1 Custom Skills (Today, Manual)

```bash
# Clone the skill repo
git clone git@github.com:mellanon/pai-skill-jira.git ~/Developer/pai-skill-jira/

# Install CLI dependencies
cd ~/Developer/pai-skill-jira && bun install

# Create symlinks
ln -sfn ~/Developer/pai-skill-jira/skill ~/.claude/skills/_JIRA
ln -sfn ~/Developer/pai-skill-jira ~/.claude/bin/jira

# Set up persistence (Tier 1 + 2)
# Copy secrets to ~/.config/arc/secrets/jira-work.env
# Link profiles from pai-personal-data
```

### 4.2 Community Skills (Future, via arc)

```bash
arc install extract-wisdom

# What happens internally:
# 1. RESOLVE: extract-wisdom → git repo URL from curated list
# 2. FETCH: git clone to ~/.config/arc/pkg/staging/extract-wisdom/
# 3. VERIFY: check signatures (SkillSeal / Sigstore / git commit hash)
# 4. REVIEW: display capabilities from pai-manifest.yaml
#    ┌─────────────────────────────────────────────┐
#    │  Install: ExtractWisdom v2.1.0              │
#    │  Author: danielmiessler (verified)          │
#    │  🟢 Read ~/.claude/skills/PAI/USER/         │
#    │  🟡 Network: api.openai.com                 │
#    │  🟡 Secret: OPENAI_API_KEY                  │
#    │  Risk: MEDIUM                               │
#    │  [Install] [Review] [Cancel]                │
#    └─────────────────────────────────────────────┘
# 5. POLICY: merge capabilities into patterns.yaml skill section
# 6. PLACE: symlink ~/.claude/skills/ExtractWisdom → staging dir
# 7. WIRE: bun install in src/, create bin symlink if CLI
# 8. RECORD: write to ~/.config/arc/packages.db
```

### 4.3 System Packages (Future, via arc --system)

```bash
arc install --system pai-content-filter

# System packages are different:
# - Install hooks into settings.json (not just skill symlinks)
# - Provide patterns/rules consumed by SecurityValidator
# - Cannot be disabled by non-maintainer users
# - Verified against hive allowed-signers (not just author signature)
```

### 4.4 Built-in Skills (PAI Release)

Built-in skills ship with the PAI release tree. On upgrade:

```bash
# v4.0.3 → v4.1.0
git checkout v4.1.0 -- Releases/v4.1.0/

# Recreate symlinks (scripted, not manual)
arc upgrade-core v4.1.0
# Internally:
# 1. Create all persistent symlinks (.env, CLAUDE.md, MEMORY, profiles, secrets, PAI/USER)
# 2. Re-symlink all installed custom/community skill repos
# 3. Swap main symlink: ln -sfn .../v4.1.0/.claude ~/.claude
# 4. Verify: all hooks load, all skills accessible, SecurityValidator patterns valid
```

This replaces the manual 20-line shell script from the migration doc with a single command.

---

## 5. The Enforcement Stack

How security layers compose from bottom to top:

```
┌───────────────────────────────────────────────────────────────────────┐
│ Layer 6: GOVERNANCE (pai-collab)                                      │
│ Human review, trust zones, contributor trust scoring, security audits │
│ WHO can publish skills to the curated list                            │
│ SOP: inbound-contribution-protocol.md                                 │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 5: OBSERVABILITY (SessionAudit + MEMORY/SECURITY/)              │
│ Security event logging, behavioral anomaly detection,                 │
│ drip-feed attack identification, cross-session correlation            │
│ PostToolUse: SessionAudit.hook.ts                                     │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 4: RUNTIME ENFORCEMENT (SecurityValidator + patterns.yaml)      │
│ Tool-call firewall: every Bash/Read/Write/Edit intercepted            │
│ Skill-scoped YAML policies, <10ms deterministic evaluation            │
│ PreToolUse: SecurityValidator.hook.ts                                 │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 3: INBOUND PROTECTION (pai-content-filter)                      │
│ Prompt injection detection: 34 patterns, 389 tests                    │
│ Quarantine for external content, fail-open design                     │
│ PreToolUse: ContentFilter hooks on Read/Glob/Grep                     │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 2: INSTALL-TIME VERIFICATION (arc)                          │
│ Signature verification, capability display, policy generation         │
│ Risk visualization (green/amber/red), user approval gate              │
│ CLI: arc install                                                  │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 1: OUTBOUND PROTECTION (pai-secret-scanning)                    │
│ Pre-commit: 8 custom gitleaks rules block secret leakage              │
│ CI gate: repository-level scanning on push/PR                         │
│ Pre-commit hook + GitHub Actions                                      │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 0: IDENTITY (Ed25519 signing + SkillSeal)                       │
│ Cryptographic author identity, commit signing, key discovery          │
│ Git: commit signatures, SkillSeal: package signatures                 │
└───────────────────────────────────────────────────────────────────────┘
```

### How Arbor's Model Maps to This Stack

| Arbor Concept | PAI Equivalent | Status |
|---------------|---------------|--------|
| Ed25519 agent identity | Git commit signing + SkillSeal author keys | Partial (signing exists, not integrated with arc) |
| Resource URI scheme (`arbor://fs/read`) | patterns.yaml path patterns | Shipped (SecurityValidator) |
| Capability store (ETS) | patterns.yaml skill sections | Designed (SECURITY-ARCHITECTURE.md) |
| Constraint enforcement (rate limits) | Hook-based counters | Future |
| Trust-capability sync | `arc install` generates policy from manifest | Designed |
| Consensus escalation | Human review for Community tier | Designed (pai-collab SOP) |
| Security event dual-emit | MEMORY/SECURITY/ + ivy-blackboard SSE | Partial (logging exists, SSE future) |
| Reflex system | Claude Code hooks (PreToolUse/PostToolUse) | Shipped |
| Taint tracking | Content provenance (pai-content-filter quarantine) | Shipped |

---

## 6. The Upgrade Problem (Solved)

The migration doc (v3.0 → v4.0) identified these pain points:

| Pain Point | Root Cause | Solution |
|-----------|-----------|---------|
| Custom skills lost on upgrade | Flat files in release tree | Standalone repos + symlinks |
| Secrets stranded in old version | Flat files in `~/.claude/secrets/` | Tier 1: `~/.config/arc/secrets/` |
| Config lost on `cp -r` | Symlinks dereferenced by copy | Three-tier persistence + `cp -a` |
| Manual symlink recreation | No upgrade automation | `arc upgrade-core` command |
| 20-line shell script per upgrade | Each upgrade is bespoke | Scripted: symlinks computed from installed packages |

### Target Upgrade Flow

```bash
# 1. Download new PAI release
arc upgrade-core v4.1.0

# That single command:
# a) Checks out new release directory
# b) Creates persistent symlinks:
#    .env → ~/.config/arc/.env
#    CLAUDE.md → pai-personal-data/CLAUDE.md
#    MEMORY → ~/.config/arc/MEMORY
#    profiles → pai-personal-data/profiles
#    secrets → ~/.config/arc/secrets
#    PAI/USER → ~/.config/arc/CORE_USER
#
# c) Re-symlinks all installed skills:
#    For each entry in packages.db:
#      ~/.claude/skills/{Name} → {skill_repo}/skill/
#      ~/.claude/bin/{tool} → {skill_repo}/
#
# d) Copies patterns.yaml from previous version
#    (preserves skill-scoped policies)
#
# e) Swaps main symlink:
#    ~/.claude → new release directory
#
# f) Validates:
#    All hooks load, all skills accessible, SecurityValidator works
```

**Nothing mutable is copied. Everything is symlinked. Upgrading is a symlink swap.**

---

## 7. How pai-collab Governs This

### Spoke Registration

Every distributed skill should be registered as a spoke project on pai-collab:

```yaml
# pai-collab/projects/{skill-name}/PROJECT.yaml
name: my-skill
maintainer: username
status: shipped          # proposed | building | shipped | archived
created: 2026-03-18
license: MIT
type: skill
source:
  repo: username/pai-skill-name
  branch: main

contributors:
  username:
    zone: maintainer
    since: 2026-03-18
```

### Security Review Flow

Before a skill enters the curated list (Community tier):

1. **Author** publishes skill to their own repo with signed commits
2. **Author** submits PR to curated list (pai-collab or registry repo)
3. **Automated checks** run:
   - pai-secret-scanning (no embedded secrets)
   - skill-enforcer (valid SKILL.md structure)
   - pai-content-filter (no prompt injection in docs)
   - Capability audit (manifest matches SKILL.md content)
4. **Human reviewer** evaluates using pai-collab review SOP:
   - 4-role council: Architect, Engineer, Security, Researcher
   - Structured review output following `sops/review-format.md`
5. **If approved**: Merged to curated list, available via `arc install`
6. **If rejected**: Feedback via PR comments, skill stays in author's repo (Universe tier)

### Trust Zones

pai-collab's trust model applies to skill authors:

| Zone | Who | What They Can Do |
|------|-----|-----------------|
| **Untrusted** | New contributors | Publish to own repo only (Universe) |
| **Trusted** | Track record + reviewed skills | Submit to curated list (Community) |
| **Maintainer** | Core team | Manage curated list, promote/demote skills |

---

## 8. Cross-Cutting Concerns

### 8.1 Dependency Resolution

Skills can depend on other skills:

```yaml
# pai-manifest.yaml
depends_on:
  skills:
    - name: Parser
      version: ">=1.0.0"
    - name: Research
      version: ">=2.0.0"
```

On `arc install`:
- Check if dependencies are installed
- If not: prompt to install them first
- If version mismatch: warn and offer upgrade
- **No transitive resolution in Phase 1** — flat dependencies only. npm-style deep resolution deferred until the ecosystem warrants it.

### 8.2 Skill Composition Security

When multiple skills are installed, the capability surface is the UNION of all policies. `arc audit` scans for dangerous combinations:

```bash
$ arc audit

Installed skills: 4
Total capability surface:
  Filesystem read:  12 paths
  Filesystem write: 3 paths
  Network:          5 domains
  Bash:             8 patterns
  Secrets:          4 keys

⚠️  Capability combination warnings:
  - Research (network) + Parser (file write) = download-and-write
  - _JIRA (network + secret) + _CONTEXT (file read) = potential exfil path

No policy violations found.
```

### 8.3 Skill Versioning

Skills use semver via git tags:

```bash
# Author releases new version
cd ~/Developer/pai-skill-jira
git tag v1.2.0
git push origin v1.2.0

# Users update
arc update jira
# Fetches latest tag, re-verifies, re-merges policy if capabilities changed
```

If capabilities change between versions (new network access, new secret needed), `arc update` shows the diff and requires re-approval:

```
Updating: _JIRA v1.1.0 → v1.2.0

Capability changes:
  + 🟡 Network: api.slack.com (new: Slack notifications)
  - 🟢 Read: ~/.claude/MEMORY/RESEARCH/ (removed)

[Update] [Review changes] [Skip]
```

### 8.4 Offline / Air-Gapped Operation

Skills are git repos. Once cloned, they work offline. `arc` does not require a network connection for:
- `list` (reads local packages.db)
- `audit` (reads local patterns.yaml)
- `disable/enable` (modifies local patterns.yaml)
- `info` (reads local pai-manifest.yaml)

Network required only for:
- `install` (git clone)
- `update` (git fetch)
- `search` (reads curated list from GitHub)
- `publish` (git push)

---

## 9. Implementation Roadmap

### Phase 1: Core Lifecycle (Months 1-2)

**Goal:** `arc install/disable/enable/list/audit` working for custom skills.

| Deliverable | Description |
|------------|-------------|
| `arc` CLI skeleton | Bun + Commander, TypeScript |
| `install` command | Git clone → verify → display caps → merge policy → symlink |
| `disable/enable` commands | Policy removal/restoration + file move |
| `list` command | Show installed skills with versions and capabilities |
| `audit` command | Scan total capability surface for dangerous unions |
| `upgrade-core` command | Automated PAI version upgrade with symlink management |
| patterns.yaml v2.0 | Extended schema with skill sections |
| SecurityValidator extension | Skill policy evaluation in existing hook |
| packages.db | SQLite tracking of installed packages |

### Phase 2: Distribution + Security (Months 3-4)

**Goal:** Community skills installable from curated list. Security spoke repos integrated.

| Deliverable | Description |
|------------|-------------|
| Curated list | GitHub repo with skill registry (JSON/YAML index) |
| `search` command | Search curated list by name, keyword, capability |
| `publish` command | Author publishes skill to own repo, submits PR to list |
| `--system` packages | pai-content-filter, pai-secret-scanning, skill-enforcer as system packages |
| SessionAudit hook | Behavioral anomaly detection (drip-feed attacks) |
| `update` command | Git fetch + re-verify + policy re-merge |
| Signing integration | SkillSeal or Sigstore verification at install time |

### Phase 3: Governance + Observability (Months 5-8)

**Goal:** Full review pipeline, cross-session intelligence, dashboard.

| Deliverable | Description |
|------------|-------------|
| Review pipeline | Automated checks + human review SOP via pai-collab |
| Trust tiers | Built-in (PAI release) + Community (curated list) |
| `review/attest/destate` | Reviewer attestation commands |
| Cross-session analysis | Persistent security event store with trend rules |
| ivy-blackboard integration | Security events on dashboard |
| `arc upgrade-core` hardening | Rollback support, pre-upgrade validation |

### Phase 4: Ecosystem (Month 9+)

**Goal:** Self-sustaining ecosystem with multiple contributors.

| Deliverable | Description |
|------------|-------------|
| Standards alignment | Evaluate AAIF/MCP Registry convergence, adopt if stable |
| Interactive TUI browser | `arc browse` for discovering skills |
| Auto-update for trusted tiers | Background update check + notification |
| Skill templates | `arc init` with templates for common skill patterns |
| Web-based skill directory | Public browsable catalog |

---

## 10. What Exists Today vs What's Needed

| Component | Exists? | Where | Gap |
|-----------|---------|-------|-----|
| Standalone skill repos | ✅ 7 custom skills | `~/Developer/pai-skill-*/` | Need `pai-manifest.yaml` added to each |
| Three-tier persistence | ✅ Designed + implemented | `~/.config/arc/`, `pai-personal-data/` | Working for custom skills |
| SecurityValidator hook | ✅ Shipping | `~/.claude/hooks/SecurityValidator.hook.ts` | Needs skill-scoped policy extension |
| patterns.yaml | ✅ Shipping | `PAI/USER/PAISECURITYSYSTEM/patterns.yaml` | Needs v2.0 schema with `skills:` section |
| Security event logging | ✅ Shipping | `MEMORY/SECURITY/` | Needs cross-event analysis |
| pai-secret-scanning | ✅ Shipped | `jcfischer/pai-secret-scanning` | Needs `--system` package wrapper |
| pai-content-filter | ✅ Shipped | `jcfischer/pai-content-filter` | Needs `--system` package wrapper |
| skill-enforcer | ✅ Shipped | `jcfischer/pai-skill-enforcer` | Needs `--system` package wrapper |
| pai-collab governance | ✅ Active | `mellanon/pai-collab` | Working, SOPs defined |
| Hive protocol specs | ✅ Draft/Review | `mellanon/the-hive` | Specs exist, implementation partial |
| Arbor security kernel | ✅ 8/9 phases | `~/Developer/arbor/` | Reference only — patterns, not dependency |
| **arc CLI** | ✅ Built | `the-metafactory/arc` | 10 commands, 64 tests, 202 assertions |
| **Curated skill list** | ❌ Not built | — | Needed for discovery |
| **SessionAudit hook** | ❌ Not built | — | Needed for drip-feed detection |
| **packages.db** | ✅ Built | `~/.config/arc/packages.db` | SQLite via bun:sqlite, WAL mode |
| **pai-manifest.yaml in skills** | ✅ Added | All 7 `pai-skill-*/` repos | Capability declarations for all custom skills |

---

## 11. How to Read the Design Documents

| Document | Question It Answers |
|----------|-------------------|
| **SKILL-LIFECYCLE.md** (this) | How do all the layers compose? What's the end-to-end flow? |
| [DESIGN.md](DESIGN.md) | What's the package format? How does transport/trust/governance work? |
| [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) | How does runtime enforcement work? How do we detect attacks? |
| [RESEARCH.md](RESEARCH.md) | What does the landscape look like? What do the council and red team say? |
| Migration Plan (v3→v4) | What broke during v3→v4? What must survive upgrades? (Internal document, not in repo) |

---

## License

MIT
