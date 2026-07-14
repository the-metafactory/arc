## Core Concepts

### arc-manifest.yaml

The single source of truth for every package. Declares name, version, type, capabilities, dependencies, and what the package provides. Legacy `pai-manifest.yaml` is still recognized but `arc-manifest.yaml` takes precedence.

### Runtime Requirements (`requires`)

Optional block declaring runtime dependencies arc must verify (or bootstrap) before installing the package.

```yaml
requires:
  nats: true   # package routes over the shared NATS bus; arc verifies a
               # broker is reachable (or bootstraps one locally on macOS
               # via brew / Linux via systemctl --user) before install
               # or upgrade. NATS_URL set + unreachable = hard fail with
               # actionable error; operator intent wins over auto-bootstrap.
```

Packages that opt out (`requires:` absent or `nats: false`) never invoke the broker gate. See `src/lib/nats-broker.ts` for the platform-specific bootstrap logic and `arc#152` for the operational rationale.

### `provides.files` and path tokens

A package may declare arbitrary file drops via `provides.files` — each entry
symlinks a `source` (inside the package repo) to a `target` on the host:

```yaml
provides:
  files:
    - source: bin/mytool          # path inside the package repo
      target: "{bin}/mytool"      # where it lands on the host
```

`target` supports a leading `~` (the user's home) plus these **path tokens**, so
a package declares *intent* instead of hard-coding a machine-specific path:

| Token | Resolves to | Use for |
|-------|-------------|---------|
| `{bin}` | `xdg-paths.binDir()` — `~/.local/bin` (or `~/bin` when already on `$PATH`) | PATH-accessible executables |
| `{data}` | `$XDG_DATA_HOME/metafactory/arc` (fallback `~/.local/share/metafactory/arc`) | durable app data |
| `{state}` | `$XDG_STATE_HOME/metafactory/arc` (fallback `~/.local/state/metafactory/arc`) | mutable runtime state |
| `{cache}` | `$XDG_CACHE_HOME/metafactory/arc` (fallback `~/.cache/metafactory/arc`) | regenerable cache |
| `{config}` | `$XDG_CONFIG_HOME/metafactory/arc` (fallback `~/.config/metafactory/arc`) | arc's own config |
| `{cortex-config}` | the **live cortex** config dir, existence-gated (see below) | dropping agent-pack fragments where the running cortex reads |

Tokens honor the same `$XDG_*` / `$PATH` resolution arc uses for its own dirs
(#287). The identical resolver runs at install, verify, upgrade, and remove, so a
file always lands and is cleaned up at the same computed path.

**`{cortex-config}` is NOT arc's own config** (G-18, cortex#1867). arc provisions
agent identity fragments INTO cortex's config tree, so this token resolves to
wherever the *live cortex* reads — mirroring cortex's own `resolveConfigDir`
precedence exactly, so arc never writes to a tree cortex ignores:

1. `$CORTEX_CONFIG_DIR` (trimmed; blank ⇒ unset) — verbatim, a self-contained root.
2. canonical `~/.config/metafactory/cortex` — if it exists.
3. legacy flat `~/.config/cortex` — if it exists.
4. legacy `~/.config/grove` — if it exists.
5. canonical `~/.config/metafactory/cortex` — the fresh-host default.

Note it deliberately hardcodes `.config` and does **not** consult
`$XDG_CONFIG_HOME` (unlike `{config}`), because cortex's config-dir resolver
doesn't either — matching it byte-for-byte is the point. An agent-pack manifest
therefore declares `target: "{cortex-config}/agents.d/<id>.yaml"` and lands in the
tree the running cortex actually loads, on both pre- and post-migration boxes.
arc only RESOLVES this tree; it never moves or migrates it (cortex owns that).

### Artifact Types

| Type | Installed To | What It Is |
|------|-------------|------------|
| `skill` | `~/.claude/skills/{name}/` | Directory with SKILL.md + workflows |
| `tool` | `~/.claude/bin/{name}` + PATH shim | CLI command runnable directly |
| `agent` | `~/.claude/agents/{name}.md` | Persona file, auto-discovered as subagent |
| `prompt` | `~/.claude/commands/{name}.md` | Slash command template |
| `component` | `~/.claude/components/{name}/` | Reusable component |
| `pipeline` | `~/.config/metafactory/pipelines/{name}/` | Multi-step pipeline definition |
| `action` | `~/.config/metafactory/actions/{name}/` | Pulse action (action.json + action.ts) |

### Trust Tiers

Trust flows from the **source**, not the package:

| Tier | Install Behavior |
|------|-----------------|
| `official` | Auto-approves, minimal capability display |
| `community` | Shows capabilities, requires user confirmation |
| `custom` | Risk warning, full capability review |

### Symlink-Based Installation

Packages are git-cloned to the XDG data root (`~/.local/share/metafactory/arc/repos/`) and symlinked into `~/.claude/`. Never hardcopy files into `~/.claude/`. This allows `git pull` upgrades, clean removal, and integrity verification.

### Key Paths

Since #287 arc splits its own state across the XDG base dirs (each honoring its
`$XDG_*` env var; `ARC_CONFIG_ROOT` still relocates the whole tree). An existing
install is migrated to this layout on first touch — copy-keep-source, with the
packages.db rows and `~/.claude` symlinks re-pointed in lockstep, so a botched
migration falls back to the intact legacy tree.

| Path | Class | Purpose |
|------|-------|---------|
| `~/.local/share/metafactory/arc/packages.db` | data (`$XDG_DATA_HOME`) | SQLite database tracking all installed packages |
| `~/.local/share/metafactory/arc/repos/` | data (`$XDG_DATA_HOME`) | Cloned package repositories |
| `~/.cache/metafactory/arc/cache/` | cache (`$XDG_CACHE_HOME`) | Cached remote registry indexes |
| `~/.config/metafactory/arc/sources.yaml` | config (`$XDG_CONFIG_HOME`) | Configured registry sources |
| `~/.config/metafactory/arc/secrets/` | config (`$XDG_CONFIG_HOME`) | Provisioned secrets |
| `~/.claude/skills/` | host | Installed skill symlinks |
| `~/.claude/agents/` | host | Installed agent symlinks |
| `~/.claude/commands/` | host | Installed prompt/command symlinks |
| `~/.claude/bin/` | host | Installed tool symlinks |

Legacy `~/.config/metafactory/{packages.db,pkg/…,sources.yaml}` locations are read for one migration window, then relocated as above.
