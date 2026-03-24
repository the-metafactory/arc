# Plan: Absorb Catalog + Lifecycle into pai-pkg

## Context

**The core problem:** There is no way to distribute skills in the PAI ecosystem. pai-pkg was created to solve this — inspired by apt/dpkg and npm.

**What pai-pkg already has:**
- 10 commands: install, list, info, audit, disable, enable, remove, verify, init, upgrade-core
- Two-manifest design: `package.json` (transport) + `pai-manifest.yaml` (capabilities)
- Full install pipeline: git clone → verify manifest → symlink → CLI shims → DB record
- Runtime enforcement: capabilities feed SecurityValidator.hook.ts
- 64 tests, 202 assertions

**What pai-pkg lacks (and the-library demonstrates):**
- Centralized catalog of available skills/agents/prompts
- Discovery/search across the catalog
- Cross-device sync via git-synced catalog
- Lifecycle commands: use (install/refresh), push (bidirectional), sync (batch update)
- Typed dependency references: `skill:Research`, `agent:Architect`, `prompt:task-router`

**How pai-pkg is distributed:** pai-pkg is itself a PAI skill — once installed (git clone + `bun link`), it's accessible through the agent harness AND as a CLI (`pai-pkg`). It follows the same spec-flow-bundle pattern: a coordinated package with CLI tooling, manifests, and skill files.

### How Existing PAI Skills Map to This System

PAI has three categories of distributable artifacts:

| Category | Examples | Current Location | Current Distribution |
|---|---|---|---|
| Built-in skills | Research, Thinking, Council, RedTeam, Media | `~/.claude/skills/` (in PAI release tree) | Part of PAI release |
| Personal skills | _JIRA, _COUPA, _CONTEXT | `~/Developer/pai-skill-*` → symlinked | Manual git clone + symlink |
| Named agents | Architect.md, Engineer.md, Pentester.md | `~/.claude/agents/` | Part of PAI release |

**With pai-pkg + catalog, ALL of these become manageable:**

```bash
# Built-in PAI skills — registered in catalog, source = PAI repo
pai-pkg catalog use Council
# → clones from PAI repo, installs to ~/.claude/skills/Council/

# Personal skills — installed directly (NOT in catalog, never shared)
pai-pkg install git@github.com:mellanon/pai-skill-jira.git
# → clone, verify pai-manifest.yaml, symlink, CLI shim, DB record

# Named agents — registered in catalog, source = PAI repo
pai-pkg catalog use agent:Architect
# → copies Architect.md to ~/.claude/agents/
```

---

## Design

### 1. Catalog File: `catalog.yaml`

Lives in the pai-pkg repo (git-synced). Each user's fork has their own catalog.

```yaml
# catalog.yaml — registry of available PAI artifacts
# Git-synced across devices. Pointers only.

defaults:
  skills_dir: ~/.claude/skills/
  agents_dir: ~/.claude/agents/
  prompts_dir: ~/.claude/commands/

catalog:
  skills:
    - name: Research
      description: Multi-agent research with parallel researchers
      source: https://github.com/danielmiessler/pai/blob/main/skills/Research/SKILL.md
      type: builtin
      has_cli: false

    - name: Council
      description: Multi-agent debate with visible transcripts
      source: https://github.com/danielmiessler/pai/blob/main/skills/Thinking/Council/SKILL.md
      type: builtin
      has_cli: false
      requires: [skill:Thinking]

    - name: RedTeam
      description: Adversarial stress testing and critique
      source: https://github.com/danielmiessler/pai/blob/main/skills/Thinking/RedTeam/SKILL.md
      type: builtin
      has_cli: false
      requires: [skill:Thinking]

    - name: SpecFlow
      description: Spec-driven development workflow
      source: https://github.com/jcfischer/specflow-bundle
      type: community
      has_cli: true
      bundle: true    # multi-package bundle (has install.ts)

  agents:
    - name: Architect
      description: Elite system design specialist (Serena Blackwood)
      source: https://github.com/danielmiessler/pai/blob/main/agents/Architect.md
      type: builtin

    - name: Pentester
      description: Offensive security specialist (Rook Blackburn)
      source: https://github.com/danielmiessler/pai/blob/main/agents/Pentester.md
      type: builtin

  prompts: []
```

**Key fields:**
- `type`: `builtin` (from PAI repo), `community` (third-party), `custom` (your own)
- `has_cli`: signals that install pipeline must handle `bun install` + CLI shims
- `bundle`: signals spec-flow-bundle pattern (multi-package, has install.ts)
- `requires`: typed dependency refs, resolved recursively before install

**Rules:**
- Personal skills (`_ALLCAPS`) are NEVER in the catalog — installed directly via `pai-pkg install <git-url>`
- System packages (`type: system`) get elevated trust — can't be casually disabled (aligns with JC review §6.2.1)
- Every catalog entry that goes through `pai-pkg catalog use` triggers the full security pipeline: pai-manifest.yaml verification → capability display → patterns.yaml merge → DB record

### Catalog Entry Types (aligned with JC review + council consensus)

| Type | Examples | Trust Level | Source |
|---|---|---|---|
| `builtin` | Research, Thinking, Council, Agents | Highest — ships with PAI | PAI repo |
| `community` | SpecFlow, third-party skills | Medium — reviewed by community | Community repos |
| `system` | pai-content-filter, pai-secret-scanning, skill-enforcer | Infrastructure — elevated protection | pai-collab spoke repos |
| `custom` | User's own skills | User-controlled | Private repos |

**`system` packages** (from JC's review): Infrastructure components that install hooks + patterns, not SKILL.md files. They get `--system` flag treatment — protected against casual disable, verified against hive allowed-signers, provide patterns/rules consumed by SecurityValidator.

### 2. New Commands

```bash
# Catalog management
pai-pkg catalog                    # List catalog with install status
pai-pkg catalog add <details>      # Register new entry
pai-pkg catalog search <keyword>   # Search by name/description
pai-pkg catalog remove <name>      # Remove from catalog

# Lifecycle (from the-library)
pai-pkg catalog use <name>         # Pull from source & install (or refresh)
pai-pkg catalog push <name>        # Push local changes back to source repo
pai-pkg catalog sync               # Re-pull ALL installed entries from source
pai-pkg catalog push-catalog       # Commit & push catalog.yaml to git remote
```

### 3. Integration with Security Architecture (JC Review Alignment)

The catalog is NOT a bypass of the security pipeline — it feeds INTO it:

```
catalog.yaml          pai-pkg catalog use X          patterns.yaml v2.0
(what exists)  ──→  (resolve → clone → verify)  ──→  (skill-scoped policies)
                         │                              │
                         ↓                              ↓
                    pai-manifest.yaml             SecurityValidator.hook.ts
                    (capability declarations)     (runtime enforcement)
```

**Key alignment with JC's 7 review concerns (issue #106):**
1. Union model: catalog-installed skills' capabilities merge into patterns.yaml union
2. System packages: `type: system` entries get elevated trust + disable protection
3. Manifest hash: `catalog sync` re-verifies manifest hashes (detect tampering)
4. Zero-cap = zero-grant: skills without pai-manifest.yaml get no implicit permissions
5. Composition warnings: `pai-pkg audit` warns about dangerous capability unions across catalog-installed skills

### 4. Install Pipeline per Artifact Type

`catalog use` resolves the source, then delegates to the appropriate install flow:

**Skills with CLI tooling** (`has_cli: true`):
1. Clone source repo (shallow)
2. Verify `pai-manifest.yaml` (capability declarations)
3. Run `bun install` in Tools/ or src/ dir
4. Create symlink: `~/.claude/skills/{Name}` → cloned repo
5. Create CLI shim via `createCliShim()` (PATH-accessible)
6. Record in SQLite DB

**Pure markdown skills** (`has_cli: false`):
1. Clone source repo or extract directory
2. Symlink to `~/.claude/skills/{Name}`
3. Record in DB (lighter — no capability enforcement needed)

**Bundles** (`bundle: true`):
1. Clone bundle repo
2. Run bundle's `install.ts` (spec-flow-bundle pattern)
3. Record all installed components in DB

**Agents** (single .md files):
1. Fetch agent .md from source
2. Copy to `~/.claude/agents/{Name}.md`
3. Record in DB

### 5. Source URL Resolution

Absorbed from the-library's parsing rules:

```
Local path:   /Users/me/Developer/pai-skill-jira/skill/SKILL.md
              → parent dir is the install source

GitHub URL:   https://github.com/org/repo/blob/branch/path/to/SKILL.md
              → clone https://github.com/org/repo.git
              → extract path/to/ parent directory

Raw URL:      https://raw.githubusercontent.com/org/repo/branch/path/to/SKILL.md
              → same parsing, different URL pattern
```

### 6. Typed Dependency Resolution

Absorbed from the-library. Before installing a skill, resolve `requires`:

```yaml
requires: [skill:Thinking, agent:Architect]
```

1. Look up each ref in catalog.yaml
2. If found and not installed → install it first (recursive)
3. If not found in catalog → warn user
4. Process all deps before the requested item

---

## Files to Create/Modify

| File | Action | Purpose |
|---|---|---|
| `catalog.yaml` | **Create** | The catalog (git-synced, per-user) |
| `src/commands/catalog.ts` | **Create** | All catalog subcommands |
| `src/lib/catalog.ts` | **Create** | YAML parser, install status checker, dependency resolver |
| `src/lib/source-resolver.ts` | **Create** | Parse local/GitHub/raw URLs to clone targets |
| `src/cli.ts` | **Modify** | Register `catalog` command |
| `src/types.ts` | **Modify** | Add `CatalogEntry`, `CatalogConfig`, `ArtifactType` types |
| `test/catalog.test.ts` | **Create** | Catalog operations tests |
| `test/source-resolver.test.ts` | **Create** | URL parsing tests |
| `src/lib/registry.ts` | **Create** | Fetch + parse remote registry.yaml from GitHub API |
| `test/registry.test.ts` | **Create** | Registry fetch + search tests |

### Existing code to reuse

- `src/commands/install.ts` — full install pipeline
- `src/lib/symlinks.ts` — `createSymlink()`, `createCliShim()`, `extractCliInfo()`
- `src/lib/db.ts` — SQLite tracking
- `src/lib/manifest.ts` — pai-manifest.yaml parsing
- `src/lib/paths.ts` — PAI directory conventions

---

## Community Registry (Shared Discovery)

### The Two-Level Model

| Level | What | Who Maintains | How Shared |
|---|---|---|---|
| **Personal catalog** (`catalog.yaml`) | Your installed/available skills | You (in your pai-pkg fork) | Git-synced across YOUR devices |
| **Community registry** (`registry.yaml`) | All published PAI skills | pai-pkg maintainers | Hosted in pai-pkg repo (or dedicated `pai-registry` repo), fetched by `pai-pkg search` |

**The personal catalog is like your `package.json`.** The community registry is like **npmjs.com** or **Obsidian's `community-plugins.json`**.

### Community Registry Design (Obsidian Model)

The registry lives in the **pai-pkg repo itself** (or a dedicated `pai-registry` repo) — NOT in pai-collab. pai-pkg is self-contained. Anyone in the PAI ecosystem can submit skills via PR to the registry without needing pai-collab.

```yaml
# registry.yaml — Community skill registry (in pai-pkg repo)
# Maintained via PR + review. pai-pkg fetches this for search/discovery.

registry:
  skills:
    - name: SpecFlow
      description: Spec-driven development workflow
      author: jcfischer
      source: https://github.com/jcfischer/specflow-bundle
      type: community
      status: shipped
      has_cli: true
      bundle: true
      reviewed_by: [mellanon]

    - name: ContentFilter
      description: Prompt injection detection (34 patterns, 389 tests)
      author: jcfischer
      source: https://github.com/jcfischer/pai-content-filter
      type: system
      status: shipped
      reviewed_by: [mellanon, steffen025]

    # Built-in skills from PAI core
    - name: Research
      description: Multi-agent research with parallel researchers
      author: danielmiessler
      source: https://github.com/danielmiessler/pai/blob/main/skills/Research/SKILL.md
      type: builtin
      status: shipped

  agents:
    - name: Architect
      description: Elite system design specialist (Serena Blackwood)
      author: danielmiessler
      source: https://github.com/danielmiessler/pai/blob/main/agents/Architect.md
      type: builtin
```

### Discovery → Install Workflow

```bash
# 1. DISCOVER — search the community registry
pai-pkg search "extract wisdom"
# → Fetches registry.yaml from pai-collab repo via GitHub API
# → Shows matching entries with name, description, author, status

# 2. ADD TO CATALOG — add to your personal catalog
pai-pkg catalog add extract-wisdom --from-registry
# → Copies the entry from registry.yaml into your catalog.yaml

# 3. INSTALL — pull and install
pai-pkg catalog use ExtractWisdom
# → Clone, verify manifest, symlink, CLI shims, DB record

# Combined shortcut:
pai-pkg install ExtractWisdom
# → Searches registry → adds to catalog → installs (if not already installed)
```

### Publishing to the Registry (PR-based, like Obsidian)

```bash
# Operator publishes a new skill to the community
# 1. Create the skill repo with pai-manifest.yaml
# 2. Submit PR to pai-collab adding entry to registry.yaml
# 3. Maintainers review per review-format SOP
# 4. PR merged → skill appears in `pai-pkg search`
```

**Governance:** The `reviewed_by` field tracks who attested to the skill. Community tier requires 1 reviewer attestation. System tier requires maintainer approval.

### Registry Source Configuration

```bash
# Default: pai-pkg community registry (shipped with pai-pkg)
# registry.yaml is in the pai-pkg repo — updates via git pull

# Private org: add an additional registry source
pai-pkg config add-registry https://github.com/myorg/our-pai-registry

# Search across all configured registries
pai-pkg search "jira"
```

**Self-contained model:** The registry ships WITH pai-pkg. When users fork pai-pkg, they get the community registry. When they `git pull upstream`, they get new community skills. Private orgs can add additional registry sources for their internal skills.

---

## How PAI's Built-in Skills Would Be Managed

Council, RedTeam, and Agents currently live inside the PAI release tree as directories under `~/.claude/skills/`. With the catalog:

1. **Register in catalog** with source pointing to PAI repo:
   ```yaml
   - name: Council
     source: https://github.com/danielmiessler/pai/blob/main/skills/Thinking/Council/SKILL.md
     type: builtin
     requires: [skill:Thinking]
   ```

2. **`pai-pkg catalog use Council`** clones the PAI repo (sparse or full), extracts the Council directory, installs via pipeline

3. **On PAI version upgrade:** `pai-pkg catalog sync` re-pulls all builtin skills from the latest PAI release — replacing the manual symlink recreation that currently plagues v3→v4 upgrades

4. **Agents (Architect, Engineer, Pentester)** are single .md files with personality + voice config — copied to `~/.claude/agents/`, no CLI tooling needed

---

## Distribution & Cross-Device Workflow

**How pai-pkg is distributed:**
```bash
# Option A: git clone + bun link (current)
git clone git@github.com:mellanon/pai-pkg.git ~/Developer/pai-pkg
cd ~/Developer/pai-pkg && bun install && bun link
# → pai-pkg CLI on PATH, catalog.yaml in the repo

# Option B: npm package (future)
bun add -g pai-pkg
# → catalog.yaml location configurable via pai-pkg config
```

**Cross-device restore:**
```bash
# On new machine
git clone git@github.com:you/pai-pkg.git  # your fork with your catalog.yaml
bun install && bun link
pai-pkg catalog sync                       # installs everything from catalog
# → all skills cloned, symlinked, CLI shims created, DB populated
```

**Cross-harness (pi.dev):**
- `catalog.yaml` is just YAML in a git repo — portable to any harness
- A pi.dev adapter reads the same format, uses simpler install (cp vs symlink)
- The catalog is the portable artifact; the pipeline is harness-specific

---

## Verification

1. `pai-pkg catalog` shows populated catalog with install status
2. `pai-pkg catalog search council` finds the Council skill
3. `pai-pkg catalog use Council` installs via full pipeline (resolves `skill:Thinking` dep first)
4. `pai-pkg catalog use agent:Architect` copies Architect.md to `~/.claude/agents/`
5. Skills with `has_cli: true` get CLI shims and `bun install`
6. Bundle skills (`bundle: true`) run their install.ts
7. `pai-pkg catalog sync` re-pulls all installed entries
8. `pai-pkg catalog push Council` pushes local changes back to source
9. Personal skills (`_JIRA`) NOT in catalog, managed via `pai-pkg install` directly
10. Existing 64 tests still pass
11. New catalog + source-resolver tests pass
12. On fresh device: clone fork → `bun link` → `pai-pkg catalog sync` → everything restored
13. `pai-pkg search "extract"` reads registry.yaml and shows matching entries
14. `pai-pkg catalog add ExtractWisdom --from-registry` copies entry from registry to personal catalog
15. `pai-pkg install ExtractWisdom` does end-to-end: search registry → add to catalog → install
