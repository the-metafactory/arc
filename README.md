# pai-pkg

**Package management for PAI skills.** Install, publish, and share skills with cryptographic trust and tiered governance.

```bash
pai-pkg install extract-wisdom        # Install a skill
pai-pkg search security               # Search across all tiers
pai-pkg publish ./my-skill            # Share your skill
```

## The Problem

[PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure) skills are powerful but non-distributable. Each user's skill directory is a local collection with no mechanism for discovery, installation, versioning, trust verification, or sharing between users.

**The gap:** there is no `apt install extract-wisdom` equivalent for PAI.

## Architecture: Three Layers

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
|  (npm + pai-pkg CLI wrapper)                                |
+-------------------------------------------------------------+
```

**Key decisions:**
1. **npm as transport, not as trust** -- npm provides versioning, dependency resolution, and a registry. We layer our own trust on top.
2. **[SkillSeal](https://github.com/mcyork/skillseal) as signing primitive** -- integrates Ian McCutcheon's cryptographic signing framework rather than reinventing. See [Acknowledgments](#acknowledgments).
3. **Scoped packages for tiers** -- `@pai-official/extract-wisdom`, `@pai-community/my-skill`, unscoped for universe.
4. **`pai-pkg` CLI wraps npm** -- users never run npm directly.

## Repository Trust Model

Inspired by Debian's main/universe/multiverse:

| Tier | npm Scope | Trust Level | Review Required | Signing Required |
|------|-----------|-------------|-----------------|------------------|
| **Official** | `@pai-official/*` | Highest | Automated + 2 human reviewers | Author GPG/SSH + repo countersign |
| **Community** | `@pai-community/*` | Medium | Automated + 1 reviewer attestation | Author GPG/SSH signature |
| **Universe** | `@pai-universe/*` | Low | Automated checks only | Optional (flagged if unsigned) |
| **Private** | Any private scope | User-controlled | None | Optional |

### Promotion Path

```
Universe --[automated checks]--> Community review eligible
Community --[2 human reviews]--> Official eligible
Official --[regression/CVE]--> demoted
```

## Package Format

A skill package wraps the existing PAI skill structure -- no changes to existing skills required:

```
@pai-official/extract-wisdom/
  package.json              # npm transport metadata
  pai-manifest.yaml         # PAI capabilities + trust declarations
  SKILL.md                  # Standard PAI skill (UNCHANGED)
  Tools/                    # TypeScript CLI tools (UNCHANGED)
  Workflows/                # Workflow files (UNCHANGED)
  MANIFEST.json             # SkillSeal integrity manifest
  TRUST.json                # SkillSeal author identity
  SIGNATURES/               # Cryptographic signatures
  ATTESTATIONS/             # Third-party review attestations
```

### pai-manifest.yaml (Capability Declarations)

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

## Cryptographic Signing

Built on [SkillSeal](https://github.com/mcyork/skillseal) by [Ian McCutcheon](https://github.com/mcyork):

### Signing Flow
```
Author develops skill
  -> pai-pkg sign (calls skillseal sign)
  -> MANIFEST.json + SIGNATURES/ + TRUST.json generated
  -> pai-pkg publish (validates + publishes to npm)
```

### Verification Flow
```
pai-pkg install extract-wisdom
  -> Download to staging
  -> Verify MANIFEST.json integrity (SHA-256)
  -> Verify signatures against author keys (GitHub key discovery)
  -> Check trust policy (tier requirements)
  -> Display capabilities for user approval
  -> Install to ~/.claude/skills/
```

### Runtime Enforcement

SkillSeal's PreToolUse hook re-verifies signatures on every skill invocation. Tampered files = blocked execution. Fail-closed by default.

## Capability/Permission Model

Like Android permissions for PAI skills:

| Category | Controls | Example |
|----------|---------|---------|
| **filesystem** | Read/write paths | `read: ["~/.claude/MEMORY/"]` |
| **network** | External access | `domain: "api.openai.com"` |
| **bash** | Shell execution | `restricted_to: ["bun Tools/*.ts"]` |
| **secrets** | Env var access | `["OPENAI_API_KEY"]` |
| **skills** | Other skill invocation | `["Parser", "Browser"]` |
| **hooks** | Hook installation | `["PreToolUse"]` |

## Governance

### Roles

| Role | Responsibility |
|------|---------------|
| **Author** | Creates and signs skills |
| **Reviewer** | Attests to quality/safety (Community tier) |
| **Maintainer** | Manages Official tier promotions |
| **Auditor** | Security review, can issue destatements |

### Automated Quality Checks (all tiers)

- Structure validation (SKILL.md, frontmatter, directory layout)
- Capability honesty (declared vs actual)
- Dependency resolution
- Signature validity
- Path sanitization (no hardcoded user paths)
- Secret scanning
- SKILL.md validity (USE WHEN triggers, workflow routing)

## CLI

```bash
# Discovery
pai-pkg search <query>              # Search across all tiers
pai-pkg info <skill>                # Metadata, capabilities, trust
pai-pkg browse                      # Interactive TUI browser

# Installation
pai-pkg install <skill>             # Install with trust + capability review
pai-pkg remove <skill>              # Uninstall
pai-pkg update [skill]              # Update one or all
pai-pkg list                        # List installed with versions

# Authoring
pai-pkg init <name>                 # Scaffold new package
pai-pkg sign <path>                 # Sign with SkillSeal
pai-pkg lint <path>                 # Run quality checks
pai-pkg publish <path>              # Publish to tier

# Repository Management
pai-pkg sources list                # Show configured repos
pai-pkg sources add <url>           # Add npm registry

# Trust Management
pai-pkg trust list                  # Show trusted authors
pai-pkg trust add <github-user>     # Trust an author
pai-pkg trust policy                # Show/edit policies

# Review
pai-pkg review <skill>              # Download for review
pai-pkg attest <skill>              # Positive attestation
pai-pkg destate <skill>             # Negative attestation
```

## Backward Compatibility

**Zero-change guarantee:** Existing skills continue working without modification. The package system is opt-in for distribution, not mandatory for use.

| Existing Skill State | What Happens |
|---------------------|--------------|
| No package.json, no manifest | Works as before. Local only. |
| Underscore-prefixed (_COUPA) | Works as before. Private by convention. |

## Trusted Author Identity

| Level | Requirements | Capabilities |
|-------|-------------|-------------|
| **Unverified** | npm account | Universe only |
| **Verified** | GitHub linked + GPG/SSH key | Community |
| **Trusted** | 3+ attested skills, 6+ months | Nominate reviewers |
| **Maintainer** | PAI team endorsement | Manage Official tier |

## Implementation Roadmap (Revised per Community Council Review)

### Phase 1: Security Spine (MVP)
- `pai-pkg` CLI skeleton (Bun + Commander)
- Flat tarball distribution with SkillSeal signing
- Single `pai-manifest.yaml` as sole authority
- Visual risk hierarchy in install flow (green/amber/red)
- Default-deny for unsigned skills
- `init`, `install`, `sign`, `verify`, `lint` commands

### Phase 2: Standards Evaluation (after real usage)
- Evaluate AAIF, MCP Registry, Agent Skills convergence
- Decide transport: emerging standard vs npm-as-blob-store
- Author verification levels
- Capability approval refinement from user feedback

### Phase 3: Governance (if ecosystem warrants)
- Community review queue
- `review` / `attest` / `destate` workflows
- Tier promotion with automated, transparent criteria

### Phase 4: Ecosystem
- Registry integration (aligned with winning standard)
- Interactive TUI browser
- Auto-update for official tier
- PAI installer integration

## Acknowledgments

This project builds on the work of several open-source projects and their authors:

- **[SkillSeal](https://github.com/mcyork/skillseal)** by [Ian McCutcheon](https://github.com/mcyork) -- Cryptographic signing and verification framework for Claude Code skills. pai-pkg integrates SkillSeal as its trust layer rather than reinventing signing. SkillSeal provides the MANIFEST.json integrity chain, GPG/SSH signature verification, GitHub-based key discovery, attestation/destatement system, and fail-closed PreToolUse hook enforcement. MIT licensed.

- **[SpecFlow](https://github.com/jcfischer/specflow-bundle)** by [Jens-Christian Fischer](https://github.com/jcfischer) -- Spec-driven development orchestration. The `pai-manifest.yaml` capability declaration format is adapted from SpecFlow's `pai-deps` manifest schema pattern (provides/depends_on/capabilities).

- **[PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/Personal_AI_Infrastructure)** by [Daniel Miessler](https://github.com/danielmiessler) -- The skill system that this package manager extends. PAI's SKILL.md format, skill directory conventions, and Algorithm execution model are the foundation.

- **Debian Project** -- The three-tier repository trust model (Official/Community/Universe) is directly inspired by Debian's main/contrib/non-free architecture and its FTP Masters governance process.

## Related Projects

- [SkillSeal](https://github.com/mcyork/skillseal) -- Signing and verification (Layer 2 primitive)
- [PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure) -- The skill platform
- [MCP Registry](https://github.com/modelcontextprotocol/registry) -- Emerging standard for MCP server discovery
- [Anthropic Agent Skills](https://agentskills.io/) -- Cross-platform skill standard

## License

MIT
