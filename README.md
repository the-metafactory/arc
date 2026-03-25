<p align="center">
  <strong>📦 pai-pkg</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version: 0.1.0" />
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Status: Alpha" />
  <img src="https://img.shields.io/badge/tests-169%20passing-brightgreen" alt="Tests: 169 passing" />
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Runtime: Bun" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platform: macOS | Linux" />
</p>

<h1 align="center">pai-pkg</h1>
<p align="center"><strong>Package management for PAI.</strong></p>
<p align="center">Install, discover, and share skills, tools, agents, and prompts<br/>with capability-based trust and multi-source registries.</p>

---

## Your Agent Needs More Skills

[PAI](https://github.com/danielmiessler/PAI) skills are powerful but non-distributable. Each user's skill directory is a local collection with no mechanism for discovery, installation, or sharing between users.

**pai-pkg is `apt install` for PAI.** It manages the full lifecycle — search a registry, review capabilities, install with one command, audit what's running.

```bash
pai-pkg search doc                # Find packages across all sources
pai-pkg install _DOC              # Install with capability review
pai-pkg audit                     # See your total attack surface
```

### What It Installs

pai-pkg handles all four PAI artifact types:

| Type | Installed To | What It Is |
|------|-------------|------------|
| **Skill** | `~/.claude/skills/{name}/` | Directory with SKILL.md + workflows |
| **Tool** | `~/.claude/bin/{name}` + PATH shim | CLI command you can run directly |
| **Agent** | `~/.claude/agents/{name}.md` | Persona file — auto-discovered as `subagent_type` |
| **Prompt** | `~/.claude/commands/{name}.md` | Slash command template |

---

## Quick Start

```bash
# Install
git clone https://github.com/mellanon/pai-pkg.git
cd pai-pkg && bun install && bun link

# Search the community registry
pai-pkg search doc

# Install a skill
pai-pkg install _DOC
```

Requires [Bun](https://bun.sh/) (v1.0+) and Git. See [QUICKSTART.md](QUICKSTART.md) for the full walkthrough.

---

## Commands

### Package Management

```bash
pai-pkg install <name-or-url>     # Install from registry or git URL
pai-pkg list                      # List installed packages
pai-pkg info <name>               # Show details and capabilities
pai-pkg audit                     # Audit total capability surface
pai-pkg disable <name>            # Disable (preserves repo)
pai-pkg enable <name>             # Re-enable a disabled package
pai-pkg remove <name>             # Completely uninstall
pai-pkg verify <name>             # Verify integrity
```

### Discovery

```bash
pai-pkg search <keyword>          # Search all configured sources
pai-pkg search --local <keyword>  # Search local registry only
```

### Source Management

```bash
pai-pkg source list               # Show configured registry sources
pai-pkg source add <n> <url>      # Add a source (--tier official|community|custom)
pai-pkg source remove <name>      # Remove a source
```

### Scaffolding

```bash
pai-pkg init my-skill             # Scaffold a new skill repo
pai-pkg init my-tool --type tool  # Scaffold a tool
pai-pkg init my-agent --type agent
pai-pkg init my-prompt --type prompt
```

### Catalog

```bash
pai-pkg catalog list              # List catalog with install status
pai-pkg catalog use <name>        # Install from catalog (resolves deps)
pai-pkg catalog sync              # Re-pull all installed catalog entries
```

---

## How It Works

```
    Community Registry              pai-pkg                    Your Machine
    ──────────────────              ───────                    ────────────
           │                           │                           │
           │  REGISTRY.yaml            │                           │
           │  (skills, tools,          │                           │
           │   agents, prompts)        │                           │
           │◄──────────────────────────│  search "doc"             │
           │                           │                           │
           │  source: github.com/...   │                           │
           │──────────────────────────►│                           │
           │                           │                           │
           │                           │  git clone → repos/       │
           │                           │──────────────────────────►│
           │                           │                           │
           │                           │  read pai-manifest.yaml   │
           │                           │  display capabilities     │
           │                           │  user confirms            │
           │                           │                           │
           │                           │  symlink → skills/        │
           │                           │  record in packages.db    │
           │                           │──────────────────────────►│
           │                           │                           │
```

**The flow:**
1. `pai-pkg search` queries cached registry files from configured sources
2. `pai-pkg install` clones the source repo via git
3. Reads `pai-manifest.yaml` — the capability declaration
4. Displays capabilities and risk level for user approval
5. Creates symlinks to the appropriate Claude directory
6. Records metadata in SQLite (`packages.db`)

No npm. No Docker. Just git clone, symlinks, and a manifest.

---

## Multi-Source Registry

pai-pkg supports multiple registry sources, like apt's sources.list:

```yaml
# ~/.config/pai/sources.yaml (auto-created on first run)
sources:
  - name: pai-collab
    url: https://raw.githubusercontent.com/mellanon/pai-collab/main/skills/REGISTRY.yaml
    tier: community
    enabled: true
```

Add additional sources:

```bash
pai-pkg source add my-team https://raw.githubusercontent.com/my-org/registry/main/REGISTRY.yaml --tier community
```

Search aggregates results across all enabled sources, showing the source name and trust tier for each match.

---

## Trust Model

Trust flows from the **source**, not the package:

| Tier | Install Behavior | Example Source |
|------|-----------------|----------------|
| **official** | Auto-approves, minimal display | Daniel Miessler's upstream PAI |
| **community** | Shows capabilities, requires confirmation | [pai-collab](https://github.com/mellanon/pai-collab) |
| **custom** | Risk warning, full capability review | Direct git URL installs |

### Capability Declarations

Every package declares what it accesses in `pai-manifest.yaml`:

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

`pai-pkg audit` shows your total attack surface across all installed packages — network domains, secrets, filesystem access, bash permissions.

---

## Package Format

A package is a git repo with `pai-manifest.yaml` at root:

```
pai-skill-example/
├── pai-manifest.yaml       # Capability declaration (required)
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

### pai-manifest.yaml

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
bun test                    # All 169 tests
bun test:unit               # Unit tests only
bun test:commands           # Command tests
bun test:e2e                # End-to-end lifecycle tests
```

Tests run in isolated temp directories — never touch real `~/.claude/` or `~/.config/`.

---

## Publishing

To add your package to a community registry, see the [pai-collab publishing guide](https://github.com/mellanon/pai-collab/blob/main/sops/skill-publishing.md).

**Requirements:**
- Public GitHub repo with `pai-manifest.yaml`
- All capabilities honestly declared
- License file (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause)
- Open a PR adding your entry to the registry's `REGISTRY.yaml`

---

## Acknowledgments

- **[PAI](https://github.com/danielmiessler/PAI)** by [Daniel Miessler](https://github.com/danielmiessler) — The skill system that this package manager extends
- **[SkillSeal](https://github.com/mcyork/skillseal)** by [Ian McCutcheon](https://github.com/mcyork) — Cryptographic signing framework for Claude Code skills (future integration)
- **[SpecFlow](https://github.com/jcfischer/specflow-bundle)** by [Jens-Christian Fischer](https://github.com/jcfischer) — The `pai-manifest.yaml` capability format is adapted from SpecFlow's manifest schema
- **[pai-collab](https://github.com/mellanon/pai-collab)** — Community coordination hub and package registry
- **Debian Project** — The multi-tier trust model is inspired by Debian's main/contrib/non-free architecture

## License

MIT
