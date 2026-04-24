<p align="center">
  <strong>📦 arc</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.14.0-blue" alt="Version: 0.14.0" />
  <img src="https://img.shields.io/badge/status-beta-yellow" alt="Status: Beta" />
  <img src="https://img.shields.io/badge/tests-457%20passing-brightgreen" alt="Tests: 457 passing" />
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Runtime: Bun" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platform: macOS | Linux" />
</p>

<h1 align="center">arc</h1>
<p align="center"><strong>Agentic skill package manager.</strong></p>
<p align="center">Install, discover, and share skills, tools, agents, and prompts<br/>with capability-based trust and multi-source registries.</p>

---

## Your Agent Needs More Skills

Claude Code skills are powerful but non-distributable. Each user's skill directory is a local collection with no mechanism for discovery, installation, or sharing between users.

**arc is `apt install` for agentic skills.** It manages the full lifecycle — search a registry, review capabilities, install with one command, audit what's running.

```bash
arc search doc                # Find packages across all sources
arc install _DOC              # Install with capability review
arc audit                     # See your total attack surface
```

### What It Installs

arc handles multiple artifact types:

| Type | Installed To | What It Is |
|------|-------------|------------|
| **Skill** | `~/.claude/skills/{name}/` | Directory with SKILL.md + workflows |
| **Tool** | `~/.claude/bin/{name}` + PATH shim | CLI command you can run directly |
| **Agent** | `~/.claude/agents/{name}.md` | Persona file -- auto-discovered as `subagent_type` |
| **Prompt** | `~/.claude/commands/{name}.md` | Slash command template |
| **Library** | `~/.config/metafactory/pkg/repos/` | Multi-artifact repo containing skills, tools, etc. |
| **Action** | `~/.config/metafactory/actions/{name}/` | Pulse action (action.json + action.ts) |
| **Rules** | `~/.claude/skills/{name}/` | Configurable rules templates (e.g. CLAUDE.md generators) |

---

## Quick Start

```bash
# Install arc
git clone https://github.com/the-metafactory/arc.git
cd arc && bun install && bun link

# Fetch the community registry
arc source update

# Search and install
arc search doc
arc install _DOC
```

Requires [Bun](https://bun.sh/) (v1.0+) and Git. Optional: [GitHub CLI](https://cli.github.com/) (`gh`) for release notes in `arc info`. See [QUICKSTART.md](QUICKSTART.md) for the full walkthrough.

---

## Commands

### Package Management

```bash
arc install <name-or-url>     # Install from registry or git URL
arc list                      # List installed packages
arc info <name>               # Show details, capabilities, and release notes
arc audit                     # Audit capability surface (summary + cross-tier warnings)
arc audit --verbose           # Full pairwise capability combination list
arc disable <name>            # Disable (preserves repo)
arc enable <name>             # Re-enable a disabled package
arc remove <name>             # Completely uninstall
arc verify <name>             # Verify manifest integrity
```

### Upgrades

```bash
arc upgrade --check           # Check for available upgrades (compares against registry)
arc upgrade                   # Upgrade all packages
arc upgrade <name>            # Upgrade a specific package
arc self-update               # Update arc itself (git pull + bun install)
arc upgrade-core <version>    # Upgrade core (symlink management)
```

### Discovery

```bash
arc search <keyword>          # Search all configured sources
```

### Source Management

```bash
arc source list               # Show configured registry sources
arc source add <n> <url>      # Add a source (--tier official|community|custom)
arc source update             # Refresh indexes from all sources (like apt update)
arc source remove <name>      # Remove a source
```

### Catalog

The catalog is a local `catalog.yaml` tracking available artifacts (built-in skills, agents). It complements the registry — the registry is for community-published packages, the catalog is for known artifacts you may want to install.

```bash
arc catalog list              # List catalog with install status
arc catalog search <keyword>  # Search catalog by name or description
arc catalog add <name>        # Add entry (--from-registry to pull from sources)
arc catalog remove <name>     # Remove entry from catalog
arc catalog use <name>        # Install from catalog (resolves deps)
arc catalog sync              # Re-pull all installed catalog entries
arc catalog push <name>       # Push local changes back to source
arc catalog push-catalog      # Commit and push catalog.yaml to git remote
```

### Scaffolding

```bash
arc init my-skill             # Scaffold a new skill repo
arc init my-tool --type tool  # Scaffold a tool
arc init my-agent --type agent
arc init my-prompt --type prompt
```

Each scaffold includes `arc-manifest.yaml`, `package.json`, `README.md`, `.gitignore`, and type-specific files (SKILL.md + workflows, agent persona, prompt template, or tool entry point).

### Bundle and Publish

```bash
arc bundle [path]             # Create a .tar.gz from a package directory
arc bundle --output out.tar.gz  # Custom output path
arc publish [path]            # Bundle, upload, and register on metafactory
arc publish --dry-run         # Validate without uploading
arc publish --tarball f.tar.gz  # Publish from existing tarball
arc publish --scope <ns>      # Override publish namespace
arc publish --source <name>   # Target specific metafactory source
```

### Authentication

```bash
arc login                     # Authenticate with metafactory (device code flow)
arc login --source <name>     # Authenticate with a specific source
arc logout                    # Remove authentication token
```

### Review (sponsor/steward)

Triage the submission queue for packages where you are the assigned sponsor — or, as a steward, any submission. Requires `trusted+` tier server-side. DD-9 blocks reviewing your own submissions.

```bash
arc review list                          # Pending submissions assigned to you
arc review list --per-page 50 --json     # Scripting-friendly, capped at 100
arc review show <id>                     # Full detail incl. validation_result
arc review approve <id>                  # Approve and advance to 'approved'
arc review reject <id> -r "reason"       # Reject (reason shown to publisher)
arc review request-changes <id> -m "..." # Request changes (comment to publisher)
```

Every `review` subcommand accepts `-s, --source <name>` to pick a metafactory source and (on `list`, `show`, and all action commands) `--json` for machine output. The first approval on a package promotes it from `draft` → `active`, making it visible on browse and the package page.

---

## How It Works

```
  sources.yaml             Registry Sources              arc                  Your Machine
  ────────────             ────────────────              ───────                  ────────────
       │                          │                         │                         │
       │  community hub           │                         │                         │
       │  personal (custom)       │                         │                         │
       │─────────────────────────►│                         │                         │
       │                          │                         │                         │
       │                          │  source update          │                         │
       │                          │  (fetch REGISTRY.yaml)  │                         │
       │                          │◄────────────────────────│                         │
       │                          │                         │                         │
       │                          │  cached indexes         │                         │
       │                          │────────────────────────►│  search "doc"           │
       │                          │                         │  (queries cached files)  │
       │                          │                         │                         │
       │                          │                         │  install _DOC           │
       │                          │                         │  → git clone            │
       │                          │                         │─────────────────────────►
       │                          │                         │                         │
       │                          │                         │  read arc-manifest.yaml │
       │                          │                         │  display capabilities   │
       │                          │                         │  user confirms          │
       │                          │                         │                         │
       │                          │                         │  symlink → skills/      │
       │                          │                         │  record in packages.db  │
       │                          │                         │─────────────────────────►
       │                          │                         │                         │
```

**The flow:**
1. `arc source update` fetches REGISTRY.yaml from each source in `sources.yaml` and caches locally
2. `arc search` queries the cached indexes across all enabled sources
3. `arc install` resolves the package from the registry, clones the source repo via git
4. Reads `arc-manifest.yaml` — the capability declaration
5. Displays capabilities and risk level for user approval
6. Creates symlinks to the appropriate Claude directory
7. For tools: runs `bun install` and creates CLI shim on PATH
8. Records metadata in SQLite (`packages.db`)

No npm. No Docker. Just git clone, symlinks, and a manifest.

---

## Multi-Source Registry

arc supports multiple registry sources, like apt's sources.list:

```yaml
# ~/.config/metafactory/sources.yaml (auto-created on first run)
sources:
  - name: community
    url: https://raw.githubusercontent.com/mellanon/pai-collab/main/skills/REGISTRY.yaml
    tier: community
    enabled: true
```

Add additional sources:

```bash
arc source add my-team https://raw.githubusercontent.com/my-org/registry/main/REGISTRY.yaml --tier community
arc source update            # Fetch indexes from all sources
```

Search aggregates results across all enabled sources, showing the source name and trust tier for each match.

---

## Trust Model

Trust flows from the **source**, not the package:

| Tier | Install Behavior | Example Source |
|------|-----------------|----------------|
| **official** | Auto-approves, minimal display | Upstream maintained packages |
| **community** | Shows capabilities, requires confirmation | Community registries |
| **custom** | Risk warning, full capability review | Direct git URL installs |

### Capability Declarations

Every package declares what it accesses in `arc-manifest.yaml`:

```yaml
capabilities:
  filesystem:
    read: ["~/.claude/MEMORY/"]
    write: ["~/.claude/MEMORY/WORK/"]
  network:
    - domain: "*.atlassian.net"
      reason: "Jira REST API"
  bash:
    allowed: true
    restricted_to: ["bun src/jira.ts *"]
  secrets: ["JIRA_URL", "JIRA_API_TOKEN"]
```

### Audit

`arc audit` shows your total attack surface and detects dangerous capability compositions across installed packages:

- **Summary mode** (default): grouped composition stats + cross-tier warnings only
- **Verbose mode** (`--verbose`): full pairwise list of all capability combination warnings

Cross-tier warnings surface when a community package's capabilities combine dangerously with your personal packages — the actually interesting signals. Same-tier combinations (your own skills) are summarized as expected.

---

## Package Format

A package is a git repo with `arc-manifest.yaml` at root:

```
arc-skill-example/
├── arc-manifest.yaml       # Capability declaration (required)
├── skill/                  # Skill directory (skills)
│   ├── SKILL.md
│   └── workflows/
├── agent/                  # Agent directory (agents)
│   └── AgentName.md
├── prompt/                 # Prompt directory (prompts)
│   └── prompt-name.md
├── src/                    # Source code (tools, skills with CLI)
│   └── tool.ts
├── package.json            # Bun dependencies (optional)
└── README.md
```

### arc-manifest.yaml

```yaml
name: _DOC
version: 1.0.0
type: skill                 # skill | tool | agent | prompt
tier: community

author:
  name: mellanon
  github: mellanon

provides:
  skill:
    - trigger: "doc"
  cli:
    - command: "bun src/doc.ts"
      name: "doc"

depends_on:
  tools:
    - name: bun
      version: ">=1.0.0"

capabilities:
  filesystem:
    read: []
    write: ["**/*.html"]
  network: []
  bash:
    allowed: false
  secrets: []
```

---

## Running Tests

```bash
bun test                    # All 457 tests
bun test:unit               # Unit tests only
bun test:commands           # Command tests
bun test:e2e                # End-to-end lifecycle tests
```

Tests run in isolated temp directories — never touch real `~/.claude/` or `~/.config/`.

---

## Versioning

Packages use [semver](https://semver.org/). The canonical version lives in `arc-manifest.yaml`:

```yaml
version: 1.2.0
```

**Convention:** bump the version, tag the commit, create a GitHub Release:

```bash
# After updating arc-manifest.yaml version to 1.2.0
git tag v1.2.0
git push origin v1.2.0
gh release create v1.2.0 --title "v1.2.0" --notes "## What Changed
- Added new workflow for X
- Fixed Y bug in Z"
```

Tags must match the manifest version (tag `v1.2.0` ↔ manifest `version: 1.2.0`).

GitHub Releases are the changelog — no separate CHANGELOG.md needed. `arc info` fetches and displays release notes directly via the `gh` CLI.

Registry entries include a `version` field to advertise the latest available version. `arc upgrade --check` compares installed versions against registry versions. Pinned installs (`arc install MySkill@1.2.0`) are planned for a future release.

---

## Publishing

arc supports publishing packages to the metafactory registry. This is the counterpart to `arc install @scope/name` -- you bundle your package locally and publish it to the registry where others can install it.

### Quick Publish

```bash
# 1. Authenticate (one-time)
arc login

# 2. Set your namespace in arc-manifest.yaml
#    namespace: my-namespace

# 3. Publish
arc publish
```

### How Publishing Works

```
arc publish
  1. Read arc-manifest.yaml
  2. Validate: name, version (semver), type, capabilities
  3. Create .tar.gz (excludes .git, node_modules, .env, test/, etc.)
  4. Upload tarball to R2 storage (content-addressed by SHA-256)
  5. Verify SHA-256: client hash must match server hash
  6. Auto-create package entry on first publish
  7. Register version (immutable -- cannot overwrite)
```

### Scope Resolution

The publish namespace is resolved in priority order:

1. `--scope` flag: `arc publish --scope my-namespace`
2. `namespace` field in `arc-manifest.yaml`
3. Account default from `/auth/me` API

### Bundle Exclusions

By default, these patterns are excluded from the tarball:

- **VCS / OS:** `.git`, `.DS_Store`, `Thumbs.db`
- **Secrets:** `.env`, `.env.*`
- **Databases / logs:** `*.db`, `*.sqlite`, `*.log`
- **JS / TS build + cache:** `node_modules`, `dist`, `build`, `out`, `coverage`, `.nyc_output`, `.next`, `.turbo`, `.parcel-cache`, `.pnpm-store`
- **Bun:** `.*.bun-build` (compiled-binary cache)
- **Rust:** `target`
- **Python:** `.venv`, `__pycache__`, `*.pyc`
- **Prior bundle artefacts:** `*.tar.gz`, `*.tgz`
- **arc / Cloudflare / Claude local state:** `.specify`, `.wrangler`, `.claude`
- **Tests:** `test`, `tests` (override via `bundle.include` if your package ships tests)

Extend or override in `arc-manifest.yaml`:

```yaml
bundle:
  exclude:
    - "*.tmp"
    - "fixtures/large"
  include:
    - "test"           # Cancels the default "test" exclusion
```

#### `bundle.include` is not an allowlist

`bundle.include` only **cancels** a matching default exclusion — an entry must appear verbatim in the default list above to have any effect. It does not filter the tarball down to a subset of files. Use `bundle.exclude` for that, or bundle a subdirectory directly (`arc bundle packages/my-pkg`). arc will warn when an `include` entry does not match any default.

### Bundling a Monorepo

If your repo is a monorepo with multiple publishable packages, there are two supported patterns:

**1. Bundle one package at a time**

Each package directory has its own `arc-manifest.yaml`. Run `arc bundle` against the subdirectory:

```bash
arc bundle packages/my-skill
arc publish packages/my-skill
```

**2. Library root**

Declare the repo root as a `library` with an `artifacts:` list. Each artifact is a subdirectory that contains its own `arc-manifest.yaml`.

```yaml
# /arc-manifest.yaml  (repo root)
name: my-library
version: 1.0.0
type: library
artifacts:
  - path: packages/skill-a
    description: Skill A
  - path: packages/tool-b
    description: Tool B
```

With the library pattern, `arc install` installs every artifact, and `arc bundle packages/skill-a` bundles only that subtree — ignoring the rest of the monorepo (including `node_modules`, build caches, sibling packages, etc.).

### Dry Run

Preview what would be published without uploading:

```bash
arc publish --dry-run
# [DRY RUN] Would publish @my-namespace/my-skill v1.0.0
#   SHA-256:  abc123...
#   Source:   metafactory
```

### Pre-built Tarballs

Skip the bundle step and publish an existing tarball:

```bash
arc bundle --output my-skill-1.0.0.tar.gz
# ... inspect tarball contents ...
arc publish --tarball my-skill-1.0.0.tar.gz
```

### Size Limits

- Tarballs exceeding **50MB** are rejected before upload
- Tarballs exceeding **10MB** produce a warning

### Version Immutability

Published versions cannot be overwritten. To publish changes, bump the version in `arc-manifest.yaml` first:

```bash
# After editing arc-manifest.yaml to version: 1.1.0
arc publish
```

Re-running `arc publish` with the same version returns a clear error: *"Version 1.0.0 already exists. Published versions are immutable."*

### Requirements

- Authenticated with `arc login`
- Valid `arc-manifest.yaml` with `name` (lowercase alphanumeric), `version` (semver), and `type`
- A `README.md` is recommended but not required
- All capabilities must be honestly declared

---

## Reviewing Submissions

Every published version goes through human review before becoming visible (metafactory DD-6 — no automated approval at any tier). If you are listed as a package's sponsor, or you hold the `steward` tier, `arc review` lets you triage the queue from the terminal while the dedicated reviewer UI is still under construction.

### Quick Review

```bash
arc review list                 # Submissions awaiting your action
arc review show <submission-id> # Full detail (validation output, capability diff, reviewer comment)
```

### Actions

```bash
arc review approve <id>                   # Advance submission to 'approved'
arc review reject <id> -r "reason"        # Reject; reason is shown to the publisher
arc review request-changes <id> -m "..."  # Send the submission back with a comment
```

### How Reviewing Works

1. Publisher runs `arc publish`, version lands in state `pending_review` with an assigned sponsor.
2. Sponsor (or any steward) pulls the queue with `arc review list`, inspects with `arc review show`, and chooses one of the three actions.
3. On `approve`, the package transitions from `draft` to `active` on its first approval, becoming visible on browse and its package page. Subsequent approvals just promote new versions.
4. `reject` / `request-changes` store your text on the submission so the publisher sees why and what to change.

### Server-Side Guarantees

- `trusted+` tier required for every `review` subcommand (enforced server-side).
- `list` only returns submissions where `sponsor_id = you` — you never see other sponsors' queues.
- DD-9: you cannot approve, reject, or request changes on your own submissions. The server returns 403 with a clear message.
- `reject` and `request-changes` require non-empty text; both the client (arc) and the server enforce this.

### Scripting

`arc review list`, `show`, and all action commands accept `--json` for machine output. Example:

```bash
arc review list --json | jq '.submissions[] | {id, status, submitted_by}'
```

### Requirements

- Authenticated with `arc login`
- Assigned as sponsor for the package, or tier `steward`
- Tier `trusted` or higher (server enforces)

---

## Acknowledgments

- **[SkillSeal](https://github.com/mcyork/skillseal)** by [Ian McCutcheon](https://github.com/mcyork) — Cryptographic signing framework for Claude Code skills (future integration)
- **[SpecFlow](https://github.com/jcfischer/specflow-bundle)** by [Jens-Christian Fischer](https://github.com/jcfischer) — The `arc-manifest.yaml` capability format is adapted from SpecFlow's manifest schema
- **Debian Project** — The multi-tier trust model is inspired by Debian's main/contrib/non-free architecture

## License

MIT
