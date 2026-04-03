## Core Concepts

### arc-manifest.yaml

The single source of truth for every package. Declares name, version, type, capabilities, dependencies, and what the package provides. Legacy `pai-manifest.yaml` is still recognized but `arc-manifest.yaml` takes precedence.

### Artifact Types

| Type | Installed To | What It Is |
|------|-------------|------------|
| `skill` | `~/.claude/skills/{name}/` | Directory with SKILL.md + workflows |
| `tool` | `~/.claude/bin/{name}` + PATH shim | CLI command runnable directly |
| `agent` | `~/.claude/agents/{name}.md` | Persona file, auto-discovered as subagent |
| `prompt` | `~/.claude/commands/{name}.md` | Slash command template |
| `component` | `~/.claude/components/{name}/` | Reusable component |
| `pipeline` | `~/.config/arc/pipelines/{name}/` | Multi-step pipeline definition |
| `action` | `~/.config/arc/actions/{name}/` | Pulse action (action.json + action.ts) |

### Trust Tiers

Trust flows from the **source**, not the package:

| Tier | Install Behavior |
|------|-----------------|
| `official` | Auto-approves, minimal capability display |
| `community` | Shows capabilities, requires user confirmation |
| `custom` | Risk warning, full capability review |

### Symlink-Based Installation

Packages are git-cloned to `~/.config/arc/pkg/repos/` and symlinked into `~/.claude/`. Never hardcopy files into `~/.claude/`. This allows `git pull` upgrades, clean removal, and integrity verification.

### Key Paths

| Path | Purpose |
|------|---------|
| `~/.config/arc/packages.db` | SQLite database tracking all installed packages |
| `~/.config/arc/sources.yaml` | Configured registry sources |
| `~/.config/arc/pkg/repos/` | Cloned package repositories |
| `~/.config/arc/pkg/cache/` | Cached remote registry indexes |
| `~/.claude/skills/` | Installed skill symlinks |
| `~/.claude/agents/` | Installed agent symlinks |
| `~/.claude/commands/` | Installed prompt/command symlinks |
| `~/.claude/bin/` | Installed tool symlinks |
