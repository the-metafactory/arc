# PAI Skill Package Management System -- Design Specification

> A package management system for PAI skills inspired by apt/dpkg, enabling secure sharing between users with cryptographic trust, tiered repositories, and governance gates.

## Problem Statement

PAI skills are currently non-distributable. Each user's skill directory is a local collection with no mechanism for discovery, installation, versioning, trust verification, or sharing. The existing v3.0 installer handles initial PAI setup but has no post-install skill management. [SkillSeal](https://github.com/mcyork/skillseal) addresses signing but not distribution. [SpecFlow](https://github.com/jcfischer/specflow-bundle) demonstrates a viable packaging pattern (monorepo + installer + manifest) but is one project's approach, not a system-wide solution.

**The gap:** there is no `apt install extract-wisdom` equivalent for PAI.

## Architecture: Three Layers

The system is composed of three distinct layers:

```
+-------------------------------------------------------------+
|  Layer 3: GOVERNANCE                                        |
|  Trust tiers, review gates, author verification             |
|  (Debian FTP Masters model)                                 |
+-------------------------------------------------------------+
|  Layer 2: TRUST                                             |
|  Cryptographic signing, capability declarations,            |
|  verification hooks                                         |
|  (SkillSeal + pai-manifest.yaml)                            |
+-------------------------------------------------------------+
|  Layer 1: TRANSPORT                                         |
|  Package format, registry, versioning, dependencies         |
|  (npm + arc CLI wrapper)                                |
+-------------------------------------------------------------+
```

**Key decisions:**
1. **npm as transport, not as trust** -- npm gives us versioning, dependency resolution, and a registry. We layer our own trust on top.
2. **[SkillSeal](https://github.com/mcyork/skillseal) as signing primitive** -- integrate [Ian McCutcheon's](https://github.com/mcyork) cryptographic signing framework rather than reinventing.
3. **Scoped packages for tiers** -- `@pai-official/extract-wisdom`, `@pai-community/my-skill`, unscoped for universe.
4. **`arc` CLI wraps npm** -- users never run npm directly. `arc install extract-wisdom` handles fetch + verify + review + place.

---

## 1. Repository Trust Model (Three Tiers)

Inspired by Debian's main/universe/multiverse and Ubuntu's component system.

| Tier | npm Scope | Trust Level | Review Required | Signing Required | Who Can Publish |
|------|-----------|-------------|-----------------|------------------|-----------------|
| **Official** | `@pai-official/*` | Highest | Automated + 2 human reviewers (neither is author) | Author GPG/SSH + repo countersign | PAI core team or approved contributors |
| **Community** | `@pai-community/*` | Medium | Automated + 1 community reviewer attestation | Author GPG/SSH signature | Any verified author |
| **Universe** | `@pai-universe/*` | Low | Automated checks only | Optional (flagged if unsigned) | Anyone |
| **Private** | Any private npm scope or registry | User-controlled | None | Optional | Registry owner |

### Trust Semantics

- **Official** = "The PAI project vouches for this skill's quality and safety." Equivalent to Debian `main`.
- **Community** = "A verified author published this and at least one community reviewer attested to it." Equivalent to Ubuntu PPAs with attestation.
- **Universe** = "This exists, passes basic structural checks, but nobody has reviewed it." Equivalent to AUR (Arch User Repository).
- **Private** = "Your org's internal skills, never published." Equivalent to a private apt repository.

### Promotion Path

```
Universe --[automated checks pass]--> eligible for Community review
Community --[2 human reviews + quality gate]--> eligible for Official
Official --[quality regression or CVE]--> demoted to Community or Universe
```

Promotion is never automatic. Demotion can be automated (a [SkillSeal](https://github.com/mcyork/skillseal) destatement from a trusted reviewer triggers demotion).

---

## 2. Package Format

A PAI skill package is an npm package with specific structure conventions. The existing skill directory structure IS the package content -- wrapped, not replaced.

```
@pai-official/extract-wisdom/
  package.json              # npm manifest (transport metadata)
  pai-manifest.yaml         # PAI-specific manifest (capabilities, trust)
  SKILL.md                  # Standard PAI skill definition (UNCHANGED)
  Tools/                    # TypeScript CLI tools (UNCHANGED)
    package.json            # Tool dependencies (UNCHANGED)
    *.ts
  Workflows/                # Workflow markdown files (UNCHANGED)
    *.md
  MANIFEST.json             # SkillSeal file integrity manifest
  TRUST.json                # SkillSeal author/attestation metadata
  SIGNATURES/               # SkillSeal cryptographic signatures
    gpg.sig
    ssh.sig
  ATTESTATIONS/             # Third-party review attestations
    *.json
```

### package.json (npm transport layer)

```json
{
  "name": "@pai-official/extract-wisdom",
  "version": "2.1.0",
  "description": "Dynamic wisdom extraction that adapts sections to content",
  "keywords": ["pai-skill", "wisdom", "extraction"],
  "author": "danielmiessler",
  "license": "Apache-2.0",
  "pai": {
    "type": "skill",
    "tier": "official",
    "minPaiVersion": "3.0.0",
    "skillName": "ExtractWisdom",
    "entryPoint": "SKILL.md"
  },
  "dependencies": {
    "@pai-official/parser": "^1.0.0"
  }
}
```

The `pai` field bridges npm's world and PAI's world.

### pai-manifest.yaml (PAI capability layer)

Adapted from [SpecFlow's pai-deps manifest pattern](https://github.com/jcfischer/specflow-bundle):

```yaml
name: ExtractWisdom
version: 2.1.0
type: skill
tier: official

author:
  name: danielmiessler
  github: danielmiessler
  verified: true

provides:
  skill:
    - trigger: "extract wisdom"
    - trigger: "analyze video"
  cli:
    - command: "bun Tools/ExtractWisdom.ts"

depends_on:
  skills:
    - name: Parser
      version: ">=1.0.0"
  tools:
    - name: bun
      version: ">=1.0.0"

capabilities:
  filesystem:
    read: ["~/.claude/skills/PAI/USER/"]
    write: ["~/.claude/MEMORY/WORK/"]
  network:
    - domain: "api.openai.com"
      reason: "AI inference"
  bash:
    allowed: true
    restricted_to: ["bun Tools/*.ts"]
  secrets: ["OPENAI_API_KEY"]
```

### Why Both package.json AND pai-manifest.yaml?

`package.json` speaks npm's language (versioning, dependencies, registry). `pai-manifest.yaml` speaks PAI's language (capabilities, triggers, trust). npm doesn't understand capabilities or trust tiers -- that's PAI's domain.

---

## 3. Cryptographic Signing (SkillSeal Integration)

Rather than building a signing system, we integrate [SkillSeal](https://github.com/mcyork/skillseal) by [Ian McCutcheon](https://github.com/mcyork) as the cryptographic primitive.

### Signing Flow (Author publishes)

1. Author develops skill locally
2. `arc init MySkill` -- generates pai-manifest.yaml + package.json templates
3. Author fills in manifests
4. `arc sign MySkill` -- calls `skillseal sign` internally (MANIFEST.json, SIGNATURES/, TRUST.json)
5. `arc publish MySkill` -- validates signature, runs quality checks, publishes to npm

### Verification Flow (User installs)

1. `arc install extract-wisdom` -- resolves and downloads from npm to staging
2. **Trust verification** (before any files touch ~/.claude/skills/):
   - Check MANIFEST.json integrity (SHA-256 of all files)
   - Verify SIGNATURES/ against TRUST.json author keys
   - Verify author key against GitHub (SkillSeal key discovery)
   - Check user's trust policy (tier requirements)
   - Check for destatements
3. **Capability review** -- display requested permissions, user approves/rejects
4. **Installation** -- install deps, copy to ~/.claude/skills/, update skill-index.json
5. **Runtime enforcement** -- SkillSeal PreToolUse hook re-verifies on every invocation

### Key Discovery

GitHub-based ([SkillSeal](https://github.com/mcyork/skillseal)'s model): GPG keys from `github.com/{user}.gpg`, SSH keys from GitHub API. Future: Sigstore keyless signing.

---

## 4. Capability/Permission Model

This is the Android permissions equivalent for PAI skills. [SkillSeal](https://github.com/mcyork/skillseal) verifies WHO; the capability model declares WHAT.

| Category | What It Controls | Example |
|----------|-----------------|---------|
| **filesystem** | Read/write/delete paths | `read: ["~/.claude/MEMORY/"]` |
| **network** | External domain access | `domain: "api.openai.com"` |
| **bash** | Shell execution patterns | `restricted_to: ["bun Tools/*.ts"]` |
| **secrets** | Environment variable access | `["OPENAI_API_KEY"]` |
| **skills** | Invoking other skills | `["Parser", "Browser"]` |
| **mcp** | MCP server access | `["filesystem", "github"]` |
| **hooks** | Installing/modifying hooks | `["PreToolUse"]` |

### Enforcement Layers

1. **Install-time** -- user sees capabilities, approves or rejects
2. **Publish-time** -- automated scan compares declared capabilities against SKILL.md content
3. **Review-time** -- human reviewer validates declarations are honest
4. **Runtime** (future) -- PreToolUse hook checks declared vs actual (requires Claude Code platform support)

---

## 5. Governance Framework

### Roles

| Role | Responsibility | Assignment |
|------|---------------|------------|
| **Author** | Creates and signs skills | Self (anyone) |
| **Reviewer** | Attests to quality/safety for Community tier | Self-nominated, track record |
| **Maintainer** | Manages Official tier, promotes/demotes | PAI core team appointment |
| **Auditor** | Security review, can issue destatements | PAI security team |

### Submission Pipeline

```
UNIVERSE: Author signs -> automated checks -> published
COMMUNITY: Author signs -> automated checks -> review queue -> 1 reviewer attests -> published
OFFICIAL: Author signs -> automated checks -> official queue -> 2 maintainer reviews -> countersigned -> published
```

### Automated Quality Checks (all tiers)

| Check | Tool | What It Catches |
|-------|------|-----------------|
| Structure validation | `arc lint` | Missing SKILL.md, bad frontmatter, wrong layout |
| Capability honesty | `arc audit-capabilities` | SKILL.md references undeclared capabilities |
| Dependency resolution | `npm install --dry-run` | Broken or circular dependencies |
| Signature validity | `skillseal verify` | Unsigned, tampered, or revoked-key packages |
| Path sanitization | `arc check-paths` | Hardcoded user paths |
| Secret scan | `arc check-secrets` | Embedded API keys or credentials |
| SKILL.md validity | `arc validate-skill` | Missing USE WHEN trigger, missing routing |

### Community Review Process

Reviewers use [SkillSeal's](https://github.com/mcyork/skillseal) attestation system:

```bash
# Reviewer clones and inspects the skill
arc review @pai-community/some-skill

# If satisfied, attest
skillseal attest ./SomeSkill/ --scope security-audit

# If problems found, destate (blocks installation)
skillseal attest ./SomeSkill/ --reject --reason "Exfiltrates env vars"
```

---

## 6. CLI Design (arc)

```bash
# Discovery
arc search <query>              # Search across all tiers
arc info <skill>                # Metadata, capabilities, trust
arc browse                      # Interactive TUI browser

# Installation
arc install <skill>             # Install with trust + capability review
arc remove <skill>              # Uninstall
arc update [skill]              # Update one or all
arc list                        # List installed with versions

# Authoring
arc init <name>                 # Scaffold new package
arc sign <path>                 # Sign with SkillSeal
arc lint <path>                 # Run quality checks
arc publish <path>              # Publish to tier

# Repository Management
arc sources list                # Show configured repos
arc sources add <url>           # Add npm registry
arc sources trust <scope>       # Trust a scope

# Trust Management
arc trust list                  # Show trusted authors
arc trust add <github-user>     # Trust an author
arc trust policy                # Show/edit policies

# Review
arc review <skill>              # Download for review
arc attest <skill>              # Positive attestation
arc destate <skill>             # Negative attestation
```

### Sources Configuration (~/.config/arc/sources.yaml)

```yaml
registries:
  - url: https://registry.npmjs.org
    scopes: ["@pai-official", "@pai-community", "@pai-universe"]
    enabled: true
  - url: https://npm.mycompany.com
    scopes: ["@mycompany-pai"]
    auth: token

tier_policies:
  official:
    require_signature: true
    require_countersign: true
    auto_update: true
  community:
    require_signature: true
    require_attestation: true
  universe:
    require_signature: false
  private:
    require_signature: false
```

---

## 7. npm as Transport: Analysis

### Why It Works

| Concern | npm Solution |
|---------|-------------|
| Versioning | semver built in |
| Dependencies | Dependency resolution built in |
| Registry | npmjs.com or self-hosted (Verdaccio) |
| Search | npm search, web UI |
| Scoped packages | `@scope/package` for natural tier mapping |
| TypeScript + Markdown | `files` field includes any file type |
| Provenance | Sigstore integration available |

### Why npm Alone Is Not Enough

| Gap | Our Solution |
|-----|-------------|
| Trust (open-publish) | Layered governance (Section 5) |
| Capabilities | pai-manifest.yaml (Section 4) |
| Signing | SkillSeal (Section 3) |
| Placement | arc post-install copies to ~/.claude/skills/ |
| Semantics | `pai` field in package.json + pai-manifest.yaml |

### The Install Flow

```
arc install extract-wisdom
  1. Resolve: extract-wisdom -> @pai-official/extract-wisdom
  2. Fetch: npm pack to staging directory
  3. Verify: skillseal verify (signatures, integrity)
  4. Review: display capabilities, prompt user
  5. Place: copy to ~/.claude/skills/ExtractWisdom/
  6. Wire: bun install in Tools/, update skill-index.json
  7. Record: write to ~/.config/arc/packages.db
```

---

## 8. Backward Compatibility

### Zero-Change Guarantee

| Existing Skill State | What Happens |
|---------------------|--------------|
| No package.json, no manifest | Works exactly as before. Local only. |
| Has Tools/package.json | Works as before (tool deps, not skill packaging). |
| Underscore-prefixed (_COUPA) | Works as before. Private by convention. |

### Migration Path (Opt-In)

```bash
arc init ~/.claude/skills/ExtractWisdom    # Scaffold packaging
# Author fills in pai-manifest.yaml capabilities
arc sign ~/.claude/skills/ExtractWisdom    # Sign
arc publish ~/.claude/skills/ExtractWisdom # Publish
```

---

## 9. Trusted Author Identity

| Level | Requirements | Capabilities |
|-------|-------------|-------------|
| **Unverified** | npm account | Universe only |
| **Verified** | GitHub linked + GPG/SSH key | Community |
| **Trusted** | 3+ attested skills, 6+ months active | Nominate reviewers |
| **Maintainer** | PAI team endorsement | Manage Official tier |

---

## 10. Private Repository Support

| Option | How | Cost | Best For |
|--------|-----|------|----------|
| Private npm scope | `@mycompany/*` on npmjs.com | $7/mo | Organizations |
| Verdaccio | Self-hosted npm registry | Free | Privacy-conscious |
| Git-based | `arc install git+ssh://...` | Free | Small teams |

---

## 11. Community Review: Council Findings

A four-agent council debate (Architect, Designer, Engineer, Researcher) evaluated this design. Their findings reshape the implementation approach.

### Areas of Consensus

1. **Single manifest authority** -- The dual-manifest design (package.json + pai-manifest.yaml) creates a "two sources of truth" problem. `pai-manifest.yaml` should be the single authoritative manifest; `package.json` should be mechanically generated from it when npm transport is needed.

2. **Phase 1 = flat tarballs with signing** -- The full three-layer architecture is premature for an ecosystem that doesn't exist yet. Ship flat tarball distribution with SkillSeal signing first. No npm dependency resolution, no registry infrastructure, no governance tiers on day one.

3. **Default-deny over consent dialogs** -- The Android-style permission approval model suffers from "consent fatigue theater." Research shows 94% of UAC-style prompts are blindly approved. The install flow should use visual risk hierarchy (green/amber/red tiers based on most dangerous capability) rather than flat permission lists. Default-deny for untrusted skills.

4. **Watch standards convergence** -- The Agentic AI Foundation (AAIF, launched December 2025 with Anthropic, Google, Microsoft, OpenAI), MCP Registry (live in preview), and Anthropic's Agent Skills standard are converging fast. Building a custom registry now risks 12-18 months of throwaway work. Phase 2 should evaluate these standards before building registry infrastructure.

5. **npm attack surface is real** -- 512,000+ malicious npm packages discovered in the past year (156% YoY increase), including typosquatting, dependency confusion, and "slopsquatting" (exploiting AI-hallucinated package names). If npm is used as transport, it must be treated as a pure blob store with our own integrity verification on top.

### Remaining Tensions

| Question | Position A | Position B |
|----------|-----------|-----------|
| SkillSeal in Phase 1? | Yes -- cheap now, expensive to retrofit (Architect, Researcher) | SHA-256 checksums suffice for Phase 1 (Engineer) |
| UX design investment in Phase 1? | Yes -- "ship ugly, stay ugly," first interaction IS the design system (Designer) | Let real usage patterns reveal what UX matters (Engineer) |
| Are governance tiers viable? | Yes, with formal automated criteria (Architect) | Historically devolve into gatekeeping regardless (Researcher) |

### Impact on Design

The council findings don't invalidate the three-layer architecture -- they resequence it. The layers remain the right abstraction, but Layer 1 (Transport) should start simpler than npm, and Layer 3 (Governance) should be deferred until there's a real ecosystem to govern. The revised roadmap below reflects this.

---

## 12. Implementation Roadmap (Revised)

### Phase 1: Security Spine (MVP)
- ✅ `arc` CLI skeleton (Bun + Commander) — 10 commands, 64 tests
- Git-based distribution (Phase 1 = `git clone`, no npm)
- ✅ Single `pai-manifest.yaml` as sole authority — added to all 7 custom skill repos
- SkillSeal signing and verification at install time
- ✅ Visual risk hierarchy in install flow (green/amber/red based on capability risk)
- Default-deny for unsigned or untrusted skills
- ✅ `init`, `install`, `verify`, `list`, `info`, `audit`, `disable`, `enable`, `remove` commands
- ✅ `upgrade-core` command — automates version upgrades (symlink management)
- ✅ `packages.db` tracking — SQLite via bun:sqlite with WAL mode

### Phase 2: Standards Evaluation (after 6 months of real usage)
- Evaluate AAIF, MCP Registry, and Agent Skills convergence
- Decide: adopt emerging standard as transport OR proceed with npm-as-blob-store
- `pai-manifest.yaml` schema finalization based on real usage patterns
- Capability display and approval refinement based on user feedback
- Author verification levels

### Phase 3: Governance (only if ecosystem warrants)
- Community review queue (GitHub-based or standard-aligned)
- `review` / `attest` / `destate` workflows
- Tier promotion process with automated, transparent criteria
- Quality metrics

### Phase 4: Ecosystem
- Registry integration (aligned with whatever standard wins)
- Interactive TUI browser
- Auto-update for official tier
- Web-based skill browser
- PAI installer integration

---

## Research Foundation

This design draws from analysis of:

- **[SkillSeal](https://github.com/mcyork/skillseal)** by [Ian McCutcheon](https://github.com/mcyork) -- Cryptographic signing for Claude Code skills. GitHub-based key discovery, multi-key signing, fail-closed PreToolUse hook enforcement, attestation/destatement system. MIT licensed.
- **[SpecFlow](https://github.com/jcfischer/specflow-bundle)** by [Jens-Christian Fischer](https://github.com/jcfischer) -- Monorepo packaging with `pai-manifest.yaml` for capability declarations and `pai-deps` for dependency tracking.
- **[PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure)** by [Daniel Miessler](https://github.com/danielmiessler) -- The skill system this package manager extends.
- **Debian apt/dpkg** -- Gold standard for tiered trust. GPG chain, FTP Masters governance.
- **Homebrew** -- Community review for core taps, Sigstore bottle attestation.
- **npm/PyPI security incidents** -- Lessons from open self-publishing failures (typosquatting, dependency confusion, supply chain attacks).
- **[MCP Registry](https://github.com/modelcontextprotocol/registry)** -- Emerging standard for MCP server discovery.
- **[Anthropic Agent Skills](https://agentskills.io/)** -- Cross-platform SKILL.md standard.
- **[Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)** -- Linux Foundation umbrella for MCP, Goose, AGENTS.md.

---

## Contributing

This is an early design document. We welcome feedback and contributions:

1. **Design feedback** -- Open an issue to discuss architectural decisions
2. **Use case contributions** -- Share your skill distribution needs
3. **Security review** -- Help us strengthen the trust model
4. **Implementation** -- PRs welcome once the design stabilizes

---

## License

MIT
