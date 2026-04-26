---
name: PackageBuilder
description: >
  Build conformant arc-installable packages for the metafactory ecosystem.
  Encodes all conventions from arc manifests, blueprint tracking, compass governance,
  content-filter safety, test-rig verification, trust metadata, and PR quality standards.
  USE WHEN build package, create package, new package, author-builder, package skill,
  metafactory package, arc package, create skill, create tool, create agent, create component,
  submit package, package review, package conventions, how to build for metafactory.
triggers:
  - build package
  - create package
  - metafactory package
  - author-builder
  - package conventions
  - author persona agent
  - persona-driven agent
  - compose blueprints
  - publish bundle
---

# PackageBuilder

Build conformant packages for the metafactory ecosystem. This skill encodes the conventions, governance rules, and quality requirements that live in the heads of the metafactory maintainers and across dozens of CLAUDE.md files, design decisions, and SOPs.

This skill exists because metafactory faces the same scaling challenge the HuggingFace transformers-to-mlx team solved: how do you maintain quality when contributions outpace (or need to outpace) review capacity? The answer is the same architecture: encode conventions in a Skill, verify independently with a harness, make PRs self-documenting.

## When to Use

Use this skill when:
- Creating a new arc-installable package (skill, tool, agent, prompt, component, pipeline, action)
- Preparing a package for submission to the metafactory registry
- Reviewing whether a package meets ecosystem conventions
- Onboarding as an Author-Builder and learning the conventions
- Checking what makes a package "conformant" before submitting a PR

Do NOT use this skill for:
- Working on the metafactory registry itself (meta-factory repo)
- Modifying arc, compass, or other infrastructure repos (those have their own conventions)
- General development work that doesn't produce a distributable package

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **CreatePackage** | "build package", "create package", "new package", "author-builder onramp" | `Workflows/CreatePackage.md` |
| **SubmitPackage** | "submit package", "package review", "prepare for registry", "publish package" | `Workflows/SubmitPackage.md` |
| **PublishBundle** | "publish bundle", "bundle and publish", "arc publish round-trip", "dry-run then publish" | `Workflows/PublishBundle.md` |
| **AuthorPersonaAgent** | "author persona agent", "persona-driven agent", "compose blueprints into agent", "new agent on top of skills" | `Workflows/AuthorPersonaAgent.md` |

When neither workflow is an exact match, use this skill's convention reference (below) to answer questions about specific conventions.

---

## The Conventions

Everything below is derived from the actual metafactory source code, design decisions, and SOPs. These are not suggestions. They are the rules.

---

### 1. Arc Manifest (arc-manifest.yaml)

Every package MUST have an `arc-manifest.yaml` at its root. This is the contract between your package and the arc package manager. Arc reads this file to determine what your package provides, what it needs, and what capabilities it requests.

#### Schema

```yaml
schema: arc/v1
name: <package-name>
version: <semver>
type: <artifact-type>
tier: <trust-tier>
description: <string>
license: <license-id>

author:
  name: <full-name>
  github: <github-username>

provides:
  skill:
    - trigger: <activation-phrase>
  cli:
    - command: "bun src/cli.ts"
      name: <command-name>
  files:
    - source: <relative-path>
      target: <install-path>
  hooks:
    - event: <hook-event>
      command: <relative-path>

depends_on:
  tools:
    - name: <tool-name>
      version: ">= X.Y.Z"

capabilities:
  filesystem:
    read: ["<glob-pattern>"]
    write: ["<glob-pattern>"]
  network:
    - "https://example.com/**"
  bash:
    allowed: true|false
  secrets:
    - ENV_VAR_NAME

scripts:
  postinstall: <script-path>
  preupgrade: <script-path>
  postupgrade: <script-path>

bundle:
  exclude:
    - vendor
    - MEMORY
    - node_modules
    - .git
```

#### Field Rules

**name**: Lowercase, hyphenated. Must be unique within the namespace. Examples: `demo-skill`, `arc-skill-code-review`, `grove`.

**version**: Semantic versioning (MAJOR.MINOR.PATCH). Start at `0.1.0` for new packages. See the versioning SOP for bump rules.

**type**: Determines where arc installs the package. Only these values are valid:

| Type | Install Location | Purpose |
|------|-----------------|---------|
| `skill` | `~/.claude/skills/{name}/` | Claude Code skill with SKILL.md |
| `tool` | `~/.claude/bin/{name}` (PATH shim) | Standalone CLI tool |
| `agent` | `~/.claude/agents/{name}.md` | Agent persona definition |
| `prompt` | `~/.claude/commands/{name}.md` | Reusable prompt template |
| `component` | `~/.claude/components/{name}/` | Multi-part system (e.g., grove) |
| `pipeline` | `~/.config/metafactory/pipelines/{name}/` | Pulse pipeline definition |
| `action` | `~/.config/metafactory/actions/{name}/` | Pulse action |

**tier**: Trust tier for the package. New packages from community contributors start at `community`. Packages from `the-metafactory` org use `official`. The `core` tier is reserved for arc, compass, and grove.

| Tier | Who | Review |
|------|-----|--------|
| `core` | metafactory founders only | Design authority approval |
| `official` | the-metafactory org members | Standard PR review |
| `community` | any contributor | Sponsor review (DD-9) |
| `custom` | private/local packages | No review required |

**license**: Must be a valid SPDX identifier. The ecosystem default is `Apache-2.0` (DD-13). MIT is acceptable for simple utilities. FSL-1.1-Apache-2.0 is reserved for future cloud components.

**namespace**: For `official` and `core` packages: `the-metafactory`. For community packages: the author's GitHub username.

**capabilities**: This is a security declaration. Arc displays these to the user before installation and requires explicit confirmation. Follow the principle of least privilege:
- Only request `filesystem.read` for paths your package actually reads
- Only request `filesystem.write` for paths your package actually writes
- Only list `network` URLs your package contacts at runtime
- Set `bash.allowed: false` unless your package genuinely needs shell execution
- Only list `secrets` your package actually uses

**Capability changes trigger full review** (DD-16). If you change capabilities in a version bump, arc flags this to the user during upgrade.

**bundle.exclude**: Always exclude `vendor`, `MEMORY`, `node_modules`, `.git`, `*.test.ts`, and any development-only files. The bundle should contain only what's needed at runtime.

#### Anti-Patterns

- Do NOT omit the `capabilities` section. Even if your package needs nothing, declare empty arrays. Omission is ambiguous; explicit empty is intentional.
- Do NOT request `filesystem.write: ["**"]` or `bash.allowed: true` without genuine need. Overly broad capabilities will be flagged during review.
- Do NOT use `latest` or ranges like `*` in `depends_on` versions. Pin to a minimum.

---

### 2. Package Structure

The file layout depends on the package type, but all packages share a common pattern.

#### Skill Package (type: skill)

```
my-skill/
  arc-manifest.yaml           # package contract
  package.json                # bun dependencies (if any)
  skill/
    SKILL.md                  # skill entry point (YAML frontmatter + markdown)
    Workflows/                # sub-workflow files (one per workflow)
      CreateThing.md
      UpdateThing.md
    References/               # domain-specific reference docs (optional)
    Templates/                # template files (optional)
  src/                        # source code (if skill has CLI or logic)
    cli.ts
    lib/
  tests/                      # test files
    cli.test.ts
  blueprint.yaml              # feature tracking (if managed as ecosystem project)
  CLAUDE.md                   # agent rules for this repo
```

#### Tool Package (type: tool)

```
my-tool/
  arc-manifest.yaml
  package.json
  src/
    cli.ts                    # main entry point (referenced in arc-manifest provides.cli)
    lib/
  tests/
  blueprint.yaml
  CLAUDE.md
```

#### Agent Package (type: agent)

```
my-agent/
  arc-manifest.yaml
  agent.md                    # agent persona definition
```

#### SKILL.md Format

The SKILL.md file is the entry point for skills. It uses YAML frontmatter for metadata and markdown for content.

```yaml
---
name: SkillName
description: >
  Multi-line description of what the skill does.
  Include trigger phrases for skill activation matching.
triggers:
  - trigger phrase one
  - trigger phrase two
---
```

Required sections in the markdown body:

1. **Title and overview**: What the skill does and why
2. **When to Use / When NOT to Use**: Activation boundaries
3. **Workflow Routing Table**: Maps request patterns to workflow files
4. **Convention reference** (for complex skills): Domain knowledge the skill encodes

Optional sections:

- **Customization**: Check for user overrides at `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/{SkillName}/`
- **Voice Notification**: curl to localhost:8888/notify for audio feedback
- **Integration**: What other skills this feeds into or uses
- **Examples**: Concrete usage scenarios

#### Workflow Files

Each workflow is a separate markdown file in `skill/Workflows/`. Workflows contain step-by-step procedures with:
- Numbered steps in imperative mood
- Success criteria for each step
- Anti-patterns (what NOT to do at each step)
- Verification checks

---

### 3. Blueprint Tracking (blueprint.yaml)

If your package is tracked as an ecosystem project (registered in `compass/ecosystem/repos.yaml`), it MUST have a `blueprint.yaml` at its root.

#### Format

```yaml
schema: blueprint/v1
repo: <short-name>
features:
  - id: <PREFIX>-<NUMBER>
    name: <feature-name>
    status: planned|in-progress|done
    iteration: <iteration-number>
    depends:
      - <PREFIX>-<NUMBER>           # same-repo dependency
      - <other-repo>:<PREFIX>-<NUMBER>  # cross-repo dependency
    description: >
      One-line description of what this feature delivers.
```

#### Rules

**ID format**: Use a consistent prefix derived from the repo name. Examples: `G-` for grove, `A-` for arc, `M-` for miner, `T-` for test-rig, `P-` for pulse. Numbers are sequential within the prefix.

**Statuses**: Only three are settable by humans/agents:
- `planned`: Not started, may have unmet dependencies
- `in-progress`: Currently being worked
- `done`: Completed and merged

Three more are computed by the blueprint CLI from the dependency graph:
- `ready`: All dependencies are `done` (work can begin)
- `blocked`: Has unmet dependencies
- `next`: Blocked only by `in-progress` items (coming soon)

**Cross-repo dependencies**: Use `{repo}:{ID}` format. A feature is `blocked` if any dependency in another repo is not `done`. Example: `arc:A-100` means feature A-100 in the arc repo.

**Blueprint CLI**:
```bash
blueprint status          # Show all features with computed statuses
blueprint ready           # Show only features ready to work on
blueprint blocked         # Show blocked features and their blockers
blueprint tree            # Dependency tree visualization
blueprint lint            # Validate graph integrity (no cycles, no dangling refs)
blueprint update <repo>:<ID> --status <status>
```

**Before starting work**: Always run `blueprint ready` to check what's unblocked. Claim a feature with `blueprint update <repo>:<ID> --status in-progress`. After merging, mark `done` and run `blueprint lint`.

---

### 4. Compass Governance

Every ecosystem repo follows the governance framework defined by compass. This means your package must conform to SOPs, labeling, CLAUDE.md generation, and design lineage.

#### SOPs That Apply to Package Development

| SOP | When | Key Requirements |
|-----|------|-----------------|
| **dev-pipeline** | Starting any work | Branch naming: `feat/`, `fix/`, `chore:` prefixes. PRs required for all changes. |
| **versioning** | After merging PRs | Version bump in arc-manifest.yaml. Release title: `"{name} vX.Y.Z -- Short Description"` |
| **worktree-discipline** | Starting feature work | Use `git worktree add ../{repo}-{slug} -b feat/{branch} main`. Never work directly on main. |
| **design-process** | Creating specs or designs | Follow document lineage: Research -> DD -> Spec -> Issue -> Code |
| **pr-review** | Reviewing or submitting PRs | Code review checklist. At least one reviewer approval. |
| **retrospective** | After significant work | Extract process patterns. Document what worked and what didn't. |

#### CLAUDE.md Requirements

Every package repo MUST have a `CLAUDE.md` at its root. For ecosystem repos, this is generated from the compass template:

1. Create `agents-md.yaml` at repo root
2. Create `docs/agents-md/` directory with section files
3. Run `arc upgrade compass` to generate CLAUDE.md

The CLAUDE.md MUST include:
- Architecture section describing the repo structure
- Critical rules section
- GitHub labels table (ecosystem standard: bug, feature, infrastructure, documentation, now, next, future, handover)
- SOP table with activation conditions
- Blueprint-driven development section
- Versioning and releases section
- Worktree discipline section
- Bun preference statement (use bun, not npm/yarn/pnpm)

#### Design Lineage (SOP-7)

Every implementation must trace back through the document chain:

```
Research (evidence)
  -> Design Decision (rule, numbered DD-N)
    -> Layer Design Spec (features, acceptance criteria)
      -> Feature Issue (trackable work on GitHub)
        -> Code (implementation)
```

**Conflict resolution**: DD wins over spec. Spec wins over implementation. The design-decisions.md file in meta-factory/design/ is THE authority (46+ numbered ADRs).

#### Labels

Every issue must have:
- At least one **type label**: `bug`, `feature`, `infrastructure`, `documentation`
- At least one **priority label** (if open): `now`, `next`, `future`
- Use `handover` label for NZ/EU timezone bridge work summaries

Do NOT create ad-hoc labels. The ecosystem uses a shared label set defined in `compass/standards/labels.yaml`.

#### Naming

- **metafactory**: always lowercase, one word. Not "Metafactory", not "Meta Factory"
- GitHub org: `the-metafactory` (technical constraint)
- Domains: `meta-factory.ai`, `meta-factory.dev`, `meta-factory.io` (DNS constraint)
- Brand name in text: always `metafactory`

---

### 5. Content-Filter Safety

If your package processes external input (user messages, API responses, file contents), it must be aware of the content-filter system.

#### What Content-Filter Catches

The content-filter is an inbound security system with a four-stage pipeline:

1. **Encoding detection**: Base64, URL encoding, hex, HTML entities used to obfuscate payloads
2. **Schema validation**: Input structure matches expected Zod schemas
3. **Pattern matching**: 28+ patterns across three categories:
   - **Injection (PI-xxx)**: System prompt override, role-play triggers, context manipulation, jailbreak keywords, instruction boundaries, authority claims
   - **Encoding (ENC-xxx)**: Base64, URL, hex, HTML entity obfuscation
   - **Command (CMD-xxx)**: Bash tokenizer attacks, sandbox redirection
4. **Decision**: ALLOWED, BLOCKED, or HUMAN_REVIEW

#### What This Means for Package Authors

- If your package accepts text input from external sources, validate it before processing
- If your package generates prompts for LLMs, be aware that injected content could manipulate the prompt
- If your package writes files, respect the sandbox boundaries defined in your `capabilities` section
- If your package runs shell commands, use the command parser rather than raw string concatenation

#### Hooks

Content-filter provides PreToolUse gate hooks for Read/Glob/Grep (file scanning) and sandbox enforcement. If your package registers hooks, they must not conflict with content-filter's hooks.

---

### 6. Test-Rig Verification

The test-rig provides clean-environment testing across four tiers. When submitting a package to the registry, your package should be testable in at least Tier 0 (host) and ideally Tier 1 (devcontainer).

#### Four Tiers

| Tier | Driver | Isolation | Use |
|------|--------|-----------|-----|
| **0 - host** | Bun.spawn on host machine | Lowest | Fastest iteration, basic smoke tests |
| **1 - devcontainer** | Microsoft official image + bun | Medium | CI-ready, GitHub Actions integration |
| **2 - orb** | OrbStack Linux VM | High | Interactive debugging when devcontainer fails |
| **3 - tart** | Bare macOS Sequoia VM | Highest | Pre-release validation |

#### Six-Step Install Chain

The test-rig validates your package by running through this chain in a clean environment:

1. Provision (clean environment)
2. Install Claude Code
3. Install PAI
4. Install arc
5. Arc install your package (`arc install <name>`)
6. Smoke test (your package runs and reports version/status)

If your package fails at step 5 or 6, it is not ready for submission.

#### Test Manifest Pattern

Following the HuggingFace methodology: the agent (or author) generates a test manifest describing WHAT to test. The test-rig harness runs the actual verification. The agent never marks its own homework.

A test manifest for your package should declare:
- **Preconditions**: What must be true before testing (dependencies, env vars, config)
- **Install verification**: What files/symlinks should exist after `arc install`
- **Smoke test**: A command that proves the package works (e.g., `<tool> --version`, `<tool> status`)
- **Functional tests**: Key behaviors to verify (input -> expected output)

#### Writing Tests

Use Bun's built-in test runner:
```bash
bun test                    # Run all tests
bun test --watch            # Watch mode
bun test tests/specific.test.ts  # Single file
```

Tests should cover:
- Manifest validation (arc-manifest.yaml parses correctly)
- CLI commands (if the package provides CLI tools)
- Core logic (if the package has library code)
- Integration points (if the package interacts with other ecosystem tools)

---

### 7. Trust Metadata and Package Signing

The metafactory registry uses a five-tier trust model (DD-3). Understanding this is critical for package submission.

#### Five Verification Tiers

| Symbol | Tier | Requirements |
|--------|------|-------------|
| ○ | NEW | Account created, no trust badge |
| ◐ | IDENTIFIED | MFA enabled + identity verified |
| ● | PROVEN | Demonstrated quality contributions |
| ◆ | TRUSTED | Long-term community contributor |
| ★ | STEWARD | Ecosystem admin/operator |

#### Key Trust Principles

These are from the design-decisions.md (the authority):

- **DD-6**: No automated approval at any tier. A human must review every package submission.
- **DD-8**: MFA is a hard gate. No trust badge without MFA enabled on GitHub.
- **DD-9**: Debian sponsor model. No one publishes alone. Every community submission requires a sponsor (PROVEN+ tier) who co-signs.
- **DD-14**: Content-addressed immutable storage. Published package versions use SHA-256 hashes and cannot be modified after publication.
- **DD-15**: Scoped namespaces. Community packages use `@username/package-name` format.
- **DD-16**: Capability change triggers full review. If you bump capabilities in a version update, arc flags this and the upgrade requires re-confirmation.

#### Package Signing

- **Sigstore/cosign** (DD-11): Packages are signed using Sigstore for supply chain security
- **Registry-level signing** (DD-12): Ed25519 at registry level, published at `/.well-known/metafactory-signing-key`
- **GitHub OIDC**: Keyless signing via GitHub Actions (SLSA Level 2 provenance, DD-13)
- **SHA-256 verification**: Non-bypassable integrity check on install

#### Threat Model Awareness

The registry defends against five named adversaries:

1. **Registry Poisoner**: Floods with malicious artifacts
2. **Social Engineer**: Builds trust over years, then backdoors (xz utils pattern)
3. **Build-System Compromiser**: Clean source, malicious build output (SolarWinds pattern)
4. **Credential Thief**: Stolen token for quick publication
5. **Typosquatter**: Confusable names in flat namespace

Your package name should not be confusable with existing packages. Your build must be reproducible from source.

---

### 8. PR Quality and Signal Density

The metafactory team operates across EU and NZ timezones (12-hour gap). Every PR review cycle that requires a round-trip question costs a full day. Signal-rich PRs are not optional; they are a survival mechanism.

#### What a Good Package PR Includes

Beyond the code diff, every package PR should include structured data:

1. **Blueprint status delta**: Which features moved to `in-progress` or `done`
2. **Arc manifest changes**: Diff of capabilities, dependencies, version
3. **Test results**: Output from `bun test` (all passing)
4. **Compass validation**: Confirm CLAUDE.md is generated, labels are applied, SOPs are followed
5. **Content-filter clearance**: If applicable, confirm no patterns triggered
6. **Dependency graph**: New cross-repo dependencies introduced

#### PR Format

```markdown
## Summary
- [1-3 bullet points describing what changed and why]

## Blueprint Status
- [Feature ID]: [old status] -> [new status]

## Test Results
- `bun test`: [N/N passing]
- `bun run typecheck`: [zero errors]
- `bun run lint`: [zero warnings]

## Verification
- [ ] arc-manifest.yaml validates
- [ ] CLAUDE.md generated from template
- [ ] Labels applied (type + priority)
- [ ] Worktree used (not committed on main)
- [ ] Version bumped per SOP
```

#### Commit Messages

Follow conventional commits with ecosystem prefixes:

```
feat: add new capability to package
fix: correct manifest validation error
chore: update dependencies
docs: add architecture section to CLAUDE.md
```

The prefix determines the version bump:
- `feat:` -> minor version bump
- `fix:` -> patch version bump
- `BREAKING CHANGE:` in body -> major version bump
- `chore:`, `docs:`, `ci:` -> no version bump (but still require PR)

---

### 9. Common Anti-Patterns

These are the mistakes that waste reviewer time and delay publication. Learn them so you don't make them.

#### Manifest Anti-Patterns

- **Omitting capabilities section**: Ambiguous. Always declare, even if empty arrays.
- **Overly broad capabilities**: `filesystem.write: ["**"]` will be rejected. Scope to actual paths.
- **Missing bundle.exclude**: Shipping node_modules, .git, or test files in the bundle wastes space and may leak dev dependencies.
- **Wrong type for the artifact**: A skill that doesn't have a SKILL.md. A tool that doesn't have a CLI entry point.

#### Code Anti-Patterns

- **Using npm/yarn/pnpm instead of bun**: The ecosystem is bun-first. Use `bun install`, `bun test`, `bun run`.
- **Using dotenv**: Bun loads .env automatically. Dotenv is unnecessary.
- **Missing Zod validation**: All external input should be validated with Zod schemas. Do not use raw type assertions.
- **No error handling on CLI**: CLI tools must handle errors gracefully and exit with non-zero codes on failure.

#### Process Anti-Patterns

- **Working on main**: Always use worktrees. `git worktree add ../{repo}-{slug} -b feat/{branch} main`.
- **Skipping blueprint**: If your repo has blueprint.yaml, claim features before working and mark done after merging.
- **Ad-hoc labels**: Do not create labels. Use the ecosystem standard set.
- **Amending published commits**: Published versions are immutable. Fix forward, don't rewrite history.
- **Em dashes in documentation**: Use colons, commas, or middots instead. Em dashes signal AI-generated text.

#### Review Anti-Patterns

- **Sparse PRs**: A diff with no context forces reviewers to ask questions. Include blueprint delta, test results, and verification checklist.
- **Asserting without verification**: Never claim "tests pass" without running them. Never claim "manifest validates" without checking.
- **Agent in the review loop**: Once a human reviewer engages, the agent steps out. Do not use agents to respond to review feedback. Human-to-human review preserves judgment quality.

---

### 10. Ecosystem Integration Points

Understanding how your package fits into the larger ecosystem helps you build better integrations.

#### Arc (Package Manager)

Your package is installed, upgraded, and audited by arc:
- `arc install <name>` clones, validates manifest, creates symlinks
- `arc upgrade <name>` pulls updates, checks capability changes
- `arc audit` reviews installed packages' capability surfaces
- `arc bundle` creates a distributable tarball
- `arc publish` submits to the registry (requires sponsor for community tier)

#### Compass (Governance)

Your repo's CLAUDE.md is generated from the compass template:
- `agents-md.yaml` at repo root configures generation
- `docs/agents-md/*.md` provides repo-specific sections
- `arc upgrade compass` regenerates CLAUDE.md from source

#### Blueprint (Feature Tracking)

Your features are tracked in the ecosystem-wide dependency graph:
- Features in your `blueprint.yaml` can depend on features in other repos
- The blueprint CLI computes readiness, blocking, and next-up status
- `blueprint lint` catches cycles and dangling references

#### Pulse (Process Execution)

If your package provides actions or pipelines:
- Actions use the `spawn/action/v1` schema
- Pipelines use the `pulse/pipeline/v1` schema
- Both support capability injection and tracing

#### Grove (Event Relay)

Your package can emit events consumed by the grove dashboard:
- EventLogger hook pipes CC events to JSONL
- Grove routes events to Discord channels per repo
- Session instrumentation via `GROVE_CHANNEL`, `GROVE_AGENT_NAME` env vars

#### Miner (Process Mining)

Your development sessions are captured and analyzed:
- CC session JSONL is ingested by miner
- Traces are structured with D/A/H classification
- Patterns are clustered and composed into reusable processes

---

### 11. Verification Checklist

Before submitting your package, verify every item. Each is binary pass/fail.

#### Manifest

- [ ] `arc-manifest.yaml` exists at repo root
- [ ] `schema: arc/v1` is set
- [ ] `name` is lowercase, hyphenated, unique within namespace
- [ ] `version` follows semver, starts at `0.1.0` for new packages
- [ ] `type` is one of: skill, tool, agent, prompt, component, pipeline, action
- [ ] `license` is a valid SPDX identifier (Apache-2.0 preferred)
- [ ] `namespace` matches org or GitHub username
- [ ] `author.name` and `author.github` are set
- [ ] `capabilities` section is present (even if all arrays are empty)
- [ ] `bundle.exclude` includes vendor, MEMORY, node_modules, .git

#### Structure

- [ ] File layout matches the type (skill has skill/SKILL.md, tool has src/cli.ts, etc.)
- [ ] `package.json` exists if there are bun dependencies
- [ ] No secrets, credentials, or .env files in the repo

#### Governance

- [ ] CLAUDE.md exists (generated from compass template via `agents-md.yaml`)
- [ ] All 8 ecosystem labels applied to the GitHub repo
- [ ] SOP table present in CLAUDE.md
- [ ] Blueprint.yaml exists if repo is in `compass/ecosystem/repos.yaml`
- [ ] Conventional commit messages used throughout

#### Quality

- [ ] `bun test` passes (all tests green)
- [ ] `bun run typecheck` reports zero errors (if TypeScript)
- [ ] `bun run lint` reports zero warnings (if linting configured)
- [ ] No em dashes in any documentation
- [ ] No vague terms in SOPs or verification steps ("handle appropriately", "be careful")
- [ ] CLI tools exit with non-zero on error

#### Submission

- [ ] PR includes blueprint status delta
- [ ] PR includes test results
- [ ] PR includes arc manifest capability summary
- [ ] Worktree was used (branch is not main)
- [ ] Version bumped per versioning SOP

---

### 12. Persona-Driven Agents (Authoring Convention)

A persona-driven agent is a thin voice and routing file that sits on top of one or more versioned skill bundles. The persona is what makes the agent recognisably itself; the skill bundles are how it actually does work. This section codifies the convention so any future agent author (Forge, Distiller, Backlogger, ...) inherits the same shape.

The authoritative metafactory-level design is `forge/design/agent-platform.md`. Read it before authoring an agent, especially the manifest schema and the host-responsibilities section. This convention reference uses the same terminology (persona, blueprint, bundle, instance state) and is consistent with that doc. If anything here drifts from the design doc, the design doc wins.

#### 12.1 The Four-Layer Layout

A persona-driven agent is exactly four things, each with a clear owner and a clear lifetime.

| Layer | What it is | Where it lives | Lifetime |
|-------|-----------|----------------|----------|
| **Persona** | Voice, judgment defaults, routing table, output rules, hard rules. Pure markdown. | Inside the agent bundle as `persona.md`. Host copies to `~/.config/<host>/personas/<name>.md` on install. | Bumps with the agent manifest version. |
| **Skill bundle** (a.k.a. **blueprint**) | Procedure, scripts, workflow MDs, conventions. The HOW of one capability. | Its own arc-installable repo (`type: skill`). Installed at `~/.claude/skills/<name>/`. | Bumps with the skill bundle's own version, independent of any agent that uses it. |
| **Manifest** | The single declarative artifact that names the agent's components and their wiring. References the persona file and pins skill bundles by name + version. The portable thing a host installs. | `arc-manifest.yaml` at the agent bundle root (`type: agent`). | Bumps with the agent itself; immutable per `name@version` once published. |
| **Instance state** | Live errands, dashboard, retros, env context. The WHAT-is-happening of one running agent on one host. | Per-host operator config: `~/.config/<host>/agents/<name>/`. Owned by the AgentState bundle. | Persists across uninstalls unless `--purge-state`. |

The four layers compose in one direction only: instance state references a manifest, the manifest references bundles by name and version, a bundle ships a persona file. Information never flows back the other way. A bundle does not know which agents use it. A persona does not know which instance is running it.

#### 12.2 Bundle / Persona Decoupling

This is the lesson the metafactory got wrong twice before landing on the correct shape (grove#230). Internalise it:

- A **persona references skills by name**, via the manifest's `blueprints[]` array. It does not import them, vendor them, or wrap them.
- **Skills do not ship inside personas.** A persona file is a few hundred lines of markdown. A skill bundle is its own repo with its own version and its own publish cadence.
- **Personas do not ship inside skill bundles.** A skill is reusable across many agents (e.g. `AgentState`, `PackageBuilder`); coupling it to one persona breaks reuse.

The host wires persona and bundles together at install time by reading the manifest. The persona prompt context names the bundles it leans on; the host enforces `allowedSkills` against the same list.

#### 12.3 Blueprint Contents

A skill bundle (blueprint) is a single repo with a fixed shape. Workflows reference scripts by relative path so the bundle is portable across hosts.

```
my-skill/
  arc-manifest.yaml            # type: skill
  skill/
    SKILL.md                   # entry point: triggers + workflow routing
    Workflows/                  # one MD per discrete operation
      DoOneThing.md
      DoAnotherThing.md
    scripts/                    # bun-runnable CLIs invoked by workflows
      one-thing.ts
      another-thing.ts
    References/                 # optional domain knowledge docs
    Templates/                  # optional template files
  src/                          # if the skill also exposes library code
  tests/
  blueprint.yaml
  CLAUDE.md
```

Workflow MDs reference scripts by **relative path from the skill root** (e.g. ``bun ./scripts/one-thing.ts --arg``) so a workflow file can be read in isolation and still find its tools. Hosts that run lifecycle hooks resolve those relative paths against the bundle install location (see `forge/design/agent-platform.md` host-responsibilities section, hook invocation contract).

#### 12.4 Composition

An agent leans on multiple skills; a skill is reused across multiple agents. **Compose, don't duplicate.**

Forge (release agent) lists in its manifest:

```yaml
blueprints:
  - name: ReleaseManager       # Forge-specific procedure
    version: ">=0.1.0"
  - name: AgentState           # shared across every persona-driven agent
    version: ">=0.1.0"
  - name: PackageBuilder       # shared with anyone authoring a package
    version: ">=0.2.0"
  - name: BlueprintTracker
    version: ">=0.1.0"
```

`AgentState` and `PackageBuilder` are shared infrastructure; `ReleaseManager` is genuinely new domain logic that justifies its own bundle. Before authoring a new skill bundle, check the registry (`arc list`) for an existing one that already does what you need. Genuinely new domain logic gets its own bundle. Wrappers around existing skills do not.

When two agents both need a capability, the capability moves into a shared bundle. When a bundle starts to carry persona-specific judgment, that judgment moves into the agent persona file. The boundary is: bundles are reusable procedure, personas are agent-specific voice.

#### 12.5 Authority via Host Primitives

Persona-driven agents declare authority **declaratively in the manifest**, and the host enforces it via its existing primitives. The persona file does not invent authority mechanisms.

Manifest:

```yaml
guardrails:
  allowedDirs: ["~/Developer/<repo-in-scope>"]
  readOnlyDirs: ["~/Developer/compass"]
  allowedSkills: ["ReleaseManager", "AgentState", "PackageBuilder"]
  disallowedTools: ["Edit", "Write"]
  bashAllowlist:
    rules:
      - pattern: "^gh\\s+"
      - pattern: "^git\\s+"
      - pattern: "^arc\\s+"
```

Grove's role-resolver projects these onto CC session flags (`--allowedDirs`, `--disallowed-tools`, `GROVE_ALLOWED_SKILLS`). Pilot will project them onto its own surface. The persona must not duplicate these as prose ("you may only run gh and git" type statements buried in the markdown), because that creates two sources of truth and they will drift.

The persona file can refer to the guardrails ("you operate under the bashAllowlist declared in the manifest") but the source of truth is the manifest. If a guardrail is missing at runtime, that is a host bug (or a missing manifest field), not a prompt to fix.

#### 12.6 Two-Phase Gates for Irreversible Operations

Any operation that mutates shared state outside the agent's instance dir is a two-phase gate. **The workflow halts between phases** for an explicit operator confirmation (or upstream-agent confirmation in an agent-to-agent loop) before the irreversible step runs.

Examples that MUST be two-phase:

| Operation | Phase 1 (dry-run) | Phase 2 (commit) |
|-----------|-------------------|-------------------|
| Publish a bundle | `arc publish --dry-run` (echo sha256, scope) | `arc publish` |
| Deploy a release | render diff + announce-message preview | `wrangler deploy` / `arc upgrade <repo>` |
| Merge a PR | post review verdict + counts | `gh pr merge` |
| Bump shared config | render diff against live config | apply diff |

The implementation pattern is **one workflow file with discrete operator-confirmed steps**: a Phase 1 step that produces the dry-run artifact (sha256, diff, verdict, etc.) and ends with an explicit halt prompt; an operator-confirmation step that waits for an in-band yes/no; and a Phase 2 step that refuses to run unless the Phase 1 artifact (e.g. a recorded sha256) is present. The phases are gated by operator confirmation, not by file boundary. `PublishBundle.md` is the canonical implementation.

Anti-pattern: collapsing the two phases into one command with a `--yes` flag, or skipping the confirmation halt. The point of the gate is the human-in-the-loop pause; bypassing it via a flag or a silent fall-through defeats the design.

#### 12.7 Conformance Checklist

Before publishing a persona-driven agent, every item below MUST pass.

- [ ] Persona file is **<= 200 lines**. Longer than that and it is doing the work of a skill bundle; extract.
- [ ] Persona file ships in the agent bundle (next to `arc-manifest.yaml`), not in any skill bundle.
- [ ] Manifest declares `type: agent` and includes all nine required fields per `forge/design/agent-platform.md` (lines 159-171): `type`, `tier`, `identity`, `persona.file`, `blueprints[]`, `guardrails`, `triggers[]`, `instanceStateSpec`, `instantiation.scope`. (`hooks` and `roster[]` are recommended, not required — but `hooks.onStart` is asserted separately below.)
- [ ] Every entry in the persona's routing table maps to an existing workflow in one of the listed `blueprints[]`. No dangling references.
- [ ] No procedure is duplicated across two `blueprints[]`. If two leaned-on skills both implement the same step, the duplication moves into a shared bundle.
- [ ] No authority declared in the persona file that isn't also in `guardrails`. The manifest is the source of truth.
- [ ] `instanceStateSpec.blueprint` is set (almost always to `AgentState`).
- [ ] All `blueprints[]` entries resolve via `arc install` on a clean machine.
- [ ] `hooks.onStart` is set (typically `AgentState/ReplayPending`) so an in-flight queue is recovered after restart.
- [ ] Manifest passes `arc validate` (when `arc validate` lands per AP-102).

A persona that fails any of these is not yet a conformant agent. Fix the gap before publishing.

#### 12.8 Instance vs Bundle Separation

The bundle is read-only after `arc upgrade`; the instance state is per-operator and persists.

| Concern | Bundle (read-only) | Instance state (per-operator) |
|---------|--------------------|--------------------------------|
| Persona markdown | `~/.claude/skills/<agent>/persona.md` (host-managed copy) | Operator override at `~/.config/<host>/personas/<agent>.md.local` |
| Workflow MDs | `~/.claude/skills/<skill>/skill/Workflows/*.md` | n/a |
| Scripts | `~/.claude/skills/<skill>/skill/scripts/*.ts` | n/a |
| Errands queue | n/a | `~/.config/<host>/agents/<agent>/state.sqlite` |
| Dashboard | n/a | `~/.config/<host>/agents/<agent>/dashboard.md` |
| Retros | n/a | `~/.config/<host>/agents/<agent>/retros/` |
| Per-instance prompt context | n/a | `~/.config/<host>/agents/<agent>/CLAUDE.md` (the bridge) |

The `CLAUDE.md` in the instance folder is the **bridge** between the read-only bundle and the live state. It is the only place the agent gets to see "where am I, what is my current queue, what host am I running on" without crossing into mutation. The host writes it; the agent reads it.

Anti-patterns:

- Editing `persona.md` in the install location (the bundle copy). Host-managed; will be overwritten by the next `arc upgrade`. Use the `.md.local` sibling for env-specific tweaks.
- Storing per-operator state inside a skill bundle. State has its own scope (`per-host` / `per-network` / `per-repo` per `instantiation.scope`); bundles are global.
- Cross-instance state sharing through filesystem paths the agent invents. If two instances need to share state, that is a network-scope or repo-scope decision encoded in the manifest, not a path the persona writes.

---

## Quick Reference

### Key Paths

| What | Path |
|------|------|
| Arc packages DB | `~/.config/metafactory/packages.db` |
| Installed skills | `~/.claude/skills/{name}/` |
| Installed tools | `~/.claude/bin/{name}` |
| Installed agents | `~/.claude/agents/{name}.md` |
| Ecosystem registry | `compass/ecosystem/repos.yaml` |
| Design decisions | `meta-factory/design/design-decisions.md` |
| Label schema | `compass/standards/labels.yaml` |
| SOP directory | `compass/sops/` |
| Blueprint CLI | `blueprint` (installed via arc) |

### Key Commands

```bash
# Package management
arc install <name-or-url>
arc list --json --type <type>
arc info <name>
arc audit
arc bundle
arc publish

# Feature tracking
blueprint status
blueprint ready
blueprint update <repo>:<ID> --status <status>
blueprint lint

# Testing
bun test
bun run typecheck
bun run lint

# Governance
arc upgrade compass          # regenerate CLAUDE.md

# Worktree
git worktree add ../{repo}-{slug} -b feat/{branch} main
```

### Ecosystem Standard Stack

| Use | Tool |
|-----|------|
| Runtime | Bun (not Node.js) |
| Package manager | Bun (not npm/yarn/pnpm) |
| Test runner | Bun test (not Jest/Vitest) |
| Schema validation | Zod |
| CLI framework | Commander.js |
| Database | SQLite + Drizzle |
| PDF/rendering | Puppeteer + Chart.js |
| Templates | Handlebars |

---

## Examples

### Example 1: Creating a Simple Skill Package

```
User: "I want to build a skill that helps with writing changelog entries"

-> Invokes CreatePackage workflow
-> Scaffolds: changelog-skill/ with arc-manifest.yaml + skill/SKILL.md
-> Guides through: triggers, workflow routing, convention encoding
-> Verifies: manifest validates, SKILL.md has frontmatter, structure is correct
```

### Example 2: Preparing for Registry Submission

```
User: "My package is ready, help me submit it"

-> Invokes SubmitPackage workflow
-> Runs verification checklist
-> Generates PR with blueprint delta, test results, capability summary
-> Identifies missing items before submission
-> Notes: sponsor required for community tier packages
```

### Example 3: Convention Lookup

```
User: "What trust tier does my community package start at?"

-> No workflow needed, answers from convention reference
-> Community packages start at `community` tier
-> Require sponsor (PROVEN+ tier) per DD-9
-> Namespace: @username/package-name per DD-15
```
