<!-- Generated from metafactory ecosystem template. Customize sections marked with {PLACEHOLDER}. -->

# arc -- Agentic Component Package Manager — CLI package manager for agentic skills, tools, agents, prompts, components, and pipelines. Think `apt install` for Claude Code artifacts.

Agentic Component Package Manager — CLI package manager for agentic skills, tools, agents, prompts, components, and pipelines. Think `apt install` for Claude Code artifacts.

## Architecture

### Entry Point

- `src/cli.ts` — Main CLI entry (Commander-based). Routes all commands, manages database lifecycle.

### Commands (`src/commands/`)

| File | Command(s) | Description |
|------|-----------|-------------|
| `install.ts` | `arc install` | Install from git URL or by name from registry |
| `list.ts` | `arc list` | List installed packages (supports `--json`, `--type`) |
| `info.ts` | `arc info` | Show details, capabilities, and release notes |
| `audit.ts` | `arc audit` | Audit total capability surface with cross-tier warnings |
| `verify.ts` | `arc verify` | Verify manifest integrity of installed package |
| `disable.ts` | `arc disable` | Disable package (preserves repo clone) |
| `enable.ts` | `arc enable` | Re-enable a disabled package |
| `remove.ts` | `arc remove` | Completely uninstall a package |
| `upgrade.ts` | `arc upgrade` | Upgrade packages (supports `--check`) |
| `upgrade-core.ts` | `arc upgrade-core` | Upgrade PAI core version (symlink management) |
| `self-update.ts` | `arc self-update` | Update arc itself (git pull + bun install) |
| `init.ts` | `arc init` | Scaffold new package repo |
| `catalog.ts` | `arc catalog *` | Catalog management (list, search, add, remove, use, sync, push) |

### Libraries (`src/lib/`)

| File | Description |
|------|-------------|
| `manifest.ts` | Read and validate arc-manifest.yaml (with pai-manifest.yaml legacy fallback), risk assessment, capability formatting |
| `db.ts` | SQLite database (bun:sqlite) for installed package tracking — WAL mode, transactions for writes |
| `paths.ts` | Path resolution and directory creation. Configurable via overrides (enables test isolation) |
| `symlinks.ts` | Symlink creation/removal for skills, agents, prompts, tools. CLI shim generation for PATH-accessible tools |
| `catalog.ts` | Load/save/search catalog.yaml, dependency resolution, install-status enrichment |
| `registry.ts` | Load and search local REGISTRY.yaml files |
| `remote-registry.ts` | Fetch, cache, search, and update remote registry sources (apt-update model) |
| `sources.ts` | Manage sources.yaml configuration (add/remove/list registry sources) |
| `source-resolver.ts` | Resolve source URLs to local paths or GitHub clone URLs with branch/path extraction |
| `hooks.ts` | Register/remove Claude Code event hooks in settings.json from manifest declarations |
| `scripts.ts` | Lifecycle script runner (preinstall, postinstall, preupgrade, postupgrade) with env vars |

### Types

- `src/types.ts` — All core types: `ArcManifest`, `ArtifactType`, `Capabilities`, `InstalledSkill`, `PaiPaths`, `RegistryEntry`, `CatalogEntry`, and more.

### Data Flow

```
User command
  -> CLI routes to command handler
    -> resolve source (registry lookup or direct URL)
      -> git clone to ~/.config/arc/pkg/repos/
        -> read arc-manifest.yaml
          -> display capabilities + risk level
            -> user confirms
              -> create symlinks to ~/.claude/{skills,agents,commands,bin}/
                -> record in packages.db
                  -> run postinstall hooks (if declared)
```

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


## Naming

- **metafactory** -- always lowercase, one word. Not "Metafactory", not "Meta Factory". The GitHub org is `the-metafactory`, the repo name may be hyphenated (technical constraint), and the domains are `meta-factory.ai/.dev/.io` (DNS constraint). But the brand name is always `metafactory`.

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting -- even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work -- review what exists before racing to write code.

- **arc-manifest.yaml wins** over package.json for version, name, and type. It is the single authority.
- **Symlink discipline:** Never hardcopy files into `~/.claude/`. Always symlink from the cloned repo.
- **Database integrity:** packages.db uses WAL mode. All writes use transactions. Never bypass the DB layer.
- **Capability honesty:** Undeclared capabilities are security bugs. Every capability a package uses must be declared in its manifest.
- **Test isolation:** All tests run in temp directories via `createTestEnv()`. Never touch real `~/.claude/` or `~/.config/` during tests.
- **No silent failures:** Every error path must log or return a meaningful status. No empty catch blocks.

## Instruction Precedence

When instructions conflict, follow this priority order (highest first):

1. Security constraints (never modify user's ~/.claude without consent)
2. arc-manifest.yaml (single source of truth -- overrides code assumptions)
3. This CLAUDE.md
4. Ecosystem design decisions (from metafactory)
5. Feature specs and iteration plans
6. Runtime context (issue/PR description)

## Anti-Rationalization Rules

- Do not claim `arc install` works without running it in a test environment -- symlink creation has edge cases
- Do not assume database migrations succeed from reading the SQL -- run `bun test` with createTestEnv()
- Do not skip testing symlink cleanup in `arc remove` -- orphaned symlinks break user systems
- Do not infer catalog correctness from YAML syntax -- validate with `arc audit`
- Do not claim a command works based on the happy path -- test with missing manifests, network errors, existing installations
- Do not modify test isolation helpers (createTestEnv) without running the FULL test suite

## Tool Policy

- File reading -> Read tool (never cat)
- Search -> Grep/Glob (never find/bash grep)
- Testing -> `bun test` (always run full suite for arc -- commands interact)
- Test isolation -> Always use createTestEnv() (never test against real ~/.config/arc)
- Manifest validation -> Read + validate against schema (never assume YAML structure)
- Package database -> bun:sqlite via library functions (never raw SQL in commands)
- If `arc install` fails in tests -> check symlink permissions, path resolution, AND database state


## GitHub Labels (ecosystem standard)

All metafactory ecosystem repos use a shared label set. Do not create ad-hoc labels.

| Label | Description | Color | Purpose |
|-------|-------------|-------|---------|
| `bug` | Something isn't working | `#d73a4a` | Defect tracking |
| `documentation` | Improvements or additions to documentation | `#0075ca` | Docs work |
| `feature` | Feature specification | `#1D76DB` | Feature work |
| `infrastructure` | Cross-cutting infrastructure work | `#5319E7` | Infra/tooling |
| `now` | Currently being worked | `#0E8A16` | Priority: active |
| `next` | Next up after current work | `#FBCA04` | Priority: queued |
| `future` | Planned but not yet scheduled | `#C5DEF5` | Priority: backlog |
| `handover` | NZ/EU timezone bridge -- work session summary | `#F9D0C4` | Async handoffs |



Every issue must have at least one type label (`bug`, `feature`, `infrastructure`, `documentation`) and one priority label (`now`, `next`, `future`) if open.

## GitHub Issue Tracking
When working on a GitHub issue in this repo, keep the issue updated as you work. This is default agent behavior, not optional.

**On starting work:**
- Comment on the issue: what you're working on, which sub-task
- Example: `gh issue comment 1 --body "Starting: implement initial project structure"`

**During work:**
- When a sub-task checkbox is completed, tick it on the issue
- When you create a PR, link it to the issue (use `closes #N` or `gh pr create` with issue reference)

**On completing work:**
- Comment with a summary: what was done, what changed, any follow-up needed
- Tick completed checkboxes on both the GitHub issue AND any iteration plans
- If all checkboxes are done, close the issue

**Why:** GitHub is the shared collaboration surface. Team members and agents all read it. If you do work but don't update the issue, it looks like nothing happened.

## Standard Operating Procedures

This repo follows ecosystem SOPs defined in [compass](https://github.com/the-metafactory/compass). **Before starting work, identify which SOPs apply and Read them. Output the pre-flight line from each loaded SOP.**

| SOP | Activate when | File |
|-----|--------------|------|
| **Dev pipeline** | Creating branches, making PRs, starting any feature/fix work | `compass/sops/dev-pipeline.md` |
| **Versioning** | After merging PRs, before deploying, any version bump | `compass/sops/versioning.md` |
| **Worktree discipline** | Starting feature work (always — even solo) | `compass/sops/worktree-discipline.md` |
| **Design process** | Creating specs, design docs, or research docs | `compass/sops/design-process.md` |
| **Retrospective** | Post-work review, extracting process patterns | `compass/sops/retrospective-and-process-mining.md` |
| **New repo** | Bootstrapping a new repository in the ecosystem | `compass/sops/new-repo.md` |
| **PR review** | Reviewing a PR, before approving or merging | `compass/sops/pr-review.md` |

### Examples

**Starting a feature:**
```
Task: "Add a dashboard panel"
→ Activate: dev-pipeline + worktree
→ Read both SOPs
→ Output: "SOP: dev-pipeline | Branch: feat/g-300-panel | Prefix: feat:"
→ Output: "SOP: worktree | Worktree: ../arc-panel | Branch: feat/g-300-panel | Main: untouched"
```

**After merging a PR:**
```
Task: "Merge PR #42"
→ After merge, activate: versioning
→ Read SOP
→ Output: "SOP: versioning | Current: v0.2.0 | Bump: patch → v0.2.1"
```

## Implementation Workflow

arc uses `blueprint.yaml` for feature tracking with the prefix convention `A-{seq}` (e.g., A-100, A-201).

**Workflow:**
```
1. Check what's ready: blueprint ready
2. Claim the feature: blueprint update arc:<id> --status in-progress
3. Create feature branch: feat/{slug} (e.g., feat/list-json-output)
4. Implement with tests
5. PR -> review -> merge to main
6. Mark done: blueprint update arc:<id> --status done
7. Validate graph: blueprint lint
```

**Branch naming:** `feat/{slug}`, `fix/{slug}`, `chore/{slug}`, `docs/{slug}`, `test/{slug}`

**Conventional commits:** `feat:`, `fix:`, `chore:`, `docs:`, `test:` prefixes.

**Blueprint statuses:** `planned`, `in-progress`, `done` are settable. `ready`, `blocked`, `next` are computed from dependency graph. Cross-repo dependencies use `repo:id` format (e.g., `meta-factory:F2-200`).

## Adding a New Command (Procedure)

1. Read existing commands in src/commands/ for patterns
2. Create command file following naming convention
3. Add to command registry in cli.ts
4. Write tests using createTestEnv() -- cover: happy path, missing args, missing manifest, already installed
5. Run `bun test` -- ALL tests must pass (arc commands interact, so a new command can break existing ones)
6. Update docs/agents-md/cli-reference.md with the new command
7. Bump version in arc-manifest.yaml


## Blueprint-Driven Development

All ecosystem repos track features in `blueprint.yaml`. Before starting feature work, check the dependency graph:

```bash
# What's ready to work on? (dependencies satisfied)
blueprint ready

# Claim a feature
blueprint update {REPO_SHORT}:{ID} --status in-progress

# After PR merges
blueprint update {REPO_SHORT}:{ID} --status done
blueprint lint   # Validate graph integrity
```

**Statuses:** Only `planned`, `in-progress`, and `done` are settable. `ready`, `blocked`, and `next` are computed from the dependency graph.

**Cross-repo dependencies:** Use `{repo}:{ID}` format (e.g., `grove:G-200`, `arc:A-100`). A feature is `blocked` if any dependency in another repo isn't `done`.

## Versioning & Releases

See `compass/sops/versioning.md` for the full procedure. Key repo-specific details:

- Version source of truth: `arc-manifest.yaml`
- Release title format: `"arc vX.Y.Z -- Short Description"`
- Deploy command: `arc upgrade arc`

## Testing

arc uses `bun test` with three test categories:

```bash
bun test                    # All tests
bun test:unit               # Unit tests (test/unit/)
bun test:commands           # Command tests (test/commands/)
bun test:e2e                # End-to-end lifecycle tests (test/e2e/)
```

### Test Categories

**Unit tests** (`test/unit/`): Pure function tests for libraries.
- `catalog.test.ts`, `db.test.ts`, `hooks.test.ts`, `manifest.test.ts`, `paths.test.ts`, `registry.test.ts`, `remote-registry.test.ts`, `source-resolver.test.ts`, `sources.test.ts`

**Command tests** (`test/commands/`): Integration tests for CLI commands.
- `audit.test.ts`, `catalog.test.ts`, `disable.test.ts`, `init.test.ts`, `install.test.ts`, `lifecycle-hooks.test.ts`, `list.test.ts`, `remove.test.ts`, `upgrade-core.test.ts`, `upgrade.test.ts`, `verify.test.ts`

**E2E tests** (`test/e2e/`): Full lifecycle tests.
- `lifecycle.test.ts`

### Test Isolation

All tests use `createTestEnv()` from `test/helpers/test-env.ts`. This creates:
- Isolated temp directories simulating the full arc directory structure
- A fresh SQLite database
- Configurable `PaiPaths` pointing to the temp dirs
- A `cleanup()` function that closes the DB and removes the temp dir

Mock skill repos are created via `createMockSkillRepo()` which scaffolds a git-initialized repo with arc-manifest.yaml.

**Critical:** Tests must NEVER touch real `~/.claude/` or `~/.config/`. The `createTestEnv()` helper enforces this by providing overridden paths.

## CLI Reference

### Package Management

```bash
arc install <name-or-url>     # Install from registry or direct git URL
arc list                      # List installed packages
arc list --json               # Output as JSON
arc list --type <type>        # Filter by artifact type (skill, tool, agent, prompt, component, pipeline)
arc info <name>               # Show details, capabilities, release notes
arc audit                     # Audit capability surface (summary + cross-tier warnings)
arc audit --verbose           # Full pairwise capability combination list
arc verify <name>             # Verify manifest integrity
```

### Lifecycle

```bash
arc disable <name>            # Disable (preserves repo clone)
arc enable <name>             # Re-enable a disabled package
arc remove <name>             # Completely uninstall
```

### Upgrades

```bash
arc upgrade --check           # Check for available upgrades
arc upgrade                   # Upgrade all packages
arc upgrade <name>            # Upgrade a specific package
arc self-update               # Update arc itself (git pull + bun install)
arc upgrade-core <version>    # Upgrade PAI core version (symlink management)
```

### Discovery

```bash
arc search [keyword]          # Search all configured sources (omit keyword to list all)
```

### Source Management

```bash
arc source list               # Show configured registry sources
arc source add <name> <url>   # Add a source (--tier official|community|custom)
arc source update             # Refresh indexes from all sources (like apt update)
arc source remove <name>      # Remove a source
```

### Catalog

```bash
arc catalog list              # List catalog with install status
arc catalog search [keyword]  # Search catalog by name or description
arc catalog add <name>        # Add entry (--from-registry to pull from sources)
arc catalog remove <name>     # Remove entry from catalog
arc catalog use <name>        # Install from catalog (resolves dependencies)
arc catalog sync              # Re-pull all installed catalog entries
arc catalog push <name>       # Push local changes back to source
arc catalog push-catalog      # Commit and push catalog.yaml to git remote
```

### Scaffolding

```bash
arc init <name>               # Scaffold new skill repo (default)
arc init <name> --type tool   # Scaffold tool
arc init <name> --type agent  # Scaffold agent
arc init <name> --type prompt # Scaffold prompt
arc init <name> --type pipeline # Scaffold pipeline
```


## Multi-Agent Worktree Discipline

See `compass/sops/worktree-discipline.md` for the full procedure. Key repo-specific details:

- Worktree directory pattern: `../arc-{slug}`
- Example: `git worktree add ../arc-feature -b feat/{branch-name} main`

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
