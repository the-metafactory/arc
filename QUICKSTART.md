# arc Quickstart

Get from zero to installing and publishing skills in 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0.0 (`curl -fsSL https://bun.sh/install | bash`)
- Git
- A PAI installation (`~/.claude/skills/` directory exists)

## Install arc

```bash
git clone git@github.com:mellanon/arc.git ~/Developer/arc
cd ~/Developer/arc
bun install
bun link
```

Verify: `arc --version`

## Discover Skills

arc comes pre-configured with the [pai-collab](https://github.com/mellanon/pai-collab) community hub as a source.

```bash
# See configured sources
arc source list

# Search across all sources
arc search doc
```

Example output:
```
Found 1 match(es) across sources:

  _DOC [skill] [community] — Markdown to styled HTML conversion with template/theme system
    by mellanon | source: pai-collab
```

## Install a Skill

```bash
# Install by name (from registry)
arc install _DOC

# Or install directly from a git URL
arc install git@github.com:mellanon/pai-skill-doc.git
```

arc will:
1. Clone the repo to `~/.config/pai/pkg/repos/`
2. Show you what capabilities the skill requests
3. Create a symlink in `~/.claude/skills/`
4. Record the install in `~/.config/pai/packages.db`

## Manage Installed Skills

```bash
arc list                  # See what's installed
arc info _DOC             # Show details and capabilities
arc audit                 # Audit total capability surface
arc disable _DOC          # Temporarily disable
arc enable _DOC           # Re-enable
arc remove _DOC           # Completely uninstall
arc verify _DOC           # Check integrity
```

## Add More Sources

Add other community hubs to discover skills from different authors:

```bash
# Add a source
arc source add jcfischer-tools \
  https://raw.githubusercontent.com/jcfischer/pai-tools/main/REGISTRY.yaml \
  --tier community

# Search now includes both sources
arc search security

# Remove a source
arc source remove jcfischer-tools
```

## Publish Your Own Skill

### 1. Create your skill repo

```bash
# Scaffold a new skill
arc init MySkill --author your-github-handle
cd pai-skill-myskill
```

This creates:
```
pai-skill-myskill/
  pai-manifest.yaml    # Capability declarations
  skill/
    SKILL.md           # Skill definition
    workflows/
      Main.md          # Default workflow
```

### 2. Edit pai-manifest.yaml

Declare everything your skill needs. Be honest — undeclared capabilities will be caught in review.

```yaml
name: MySkill
version: 1.0.0
type: skill
tier: community

author:
  name: yourname
  github: your-github-handle

provides:
  skill:
    - trigger: "my skill"

depends_on:
  tools:
    - name: bun
      version: ">=1.0.0"

capabilities:
  filesystem:
    read: []
    write: ["~/Downloads/"]
  network: []
  bash:
    allowed: false
  secrets: []
```

### 3. Push to GitHub

```bash
git init && git add . && git commit -m "Initial commit"
gh repo create pai-skill-myskill --public --push
```

### 4. Register with a hub

Fork [pai-collab](https://github.com/mellanon/pai-collab), add your entry to `skills/REGISTRY.yaml`, and open a PR:

```yaml
# In skills/REGISTRY.yaml, under skills:
- name: MySkill
  description: What it does (one line)
  author: your-github-handle
  source: https://github.com/you/pai-skill-myskill
  type: community
  status: shipped
```

See the full publishing process: [pai-collab skill publishing SOP](https://github.com/mellanon/pai-collab/blob/main/sops/skill-publishing.md)

## Trust Model

Trust flows from the **source**, not the package:

| Tier | What happens on install |
|------|------------------------|
| **official** | Minimal display, auto-approved |
| **community** | Shows capabilities, user confirms |
| **custom** | Risk warning, full capability review |

Skills installed from pai-collab get **community** tier. Direct git URL installs get **custom** tier.

## What's Next

- `arc search` to explore what's available
- `arc audit` to review your total capability surface
- `arc init` to scaffold your own skill
- Read the [full README](README.md) for advanced usage
