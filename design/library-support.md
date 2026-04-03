# Library Support — Arc Design Specification

**Status:** Design Complete
**Created:** 2026-04-02
**Design Decisions:** DD-59, DD-60, DD-61
**Blueprint Features:** A-404 (Library manifest support), A-405 (Library install command)

---

## Overview

Arc currently assumes a 1:1 relationship between git repositories and installable artifacts. Each repo contains one `arc-manifest.yaml` describing one skill, tool, agent, prompt, component, or pipeline. This works well for standalone packages but creates repository sprawl when related artifacts share a common codebase or release cadence.

Library support introduces a new artifact type — `library` — that allows a single git repo to contain multiple independently-installable artifacts. A library's root manifest acts as a directory listing; each artifact subdirectory contains a standard `arc-manifest.yaml` with no schema changes. This means existing manifest validation, capability auditing, and symlink logic work unchanged for each artifact within a library.

The immediate motivation is consolidating four standalone repos (`ecosystem-digest`, `handover-digest`, `pai-skill-sop`, `arc-skill-code-review`) into a single library repo, reducing maintenance overhead while preserving independent versioning and install granularity.

---

## Root Manifest Schema

A library's root `arc-manifest.yaml` uses `type: library` and declares an `artifacts` array listing the contained artifacts with their subdirectory paths.

```yaml
schema: arc/v1
name: mf-library
version: 1.0.0
type: library
license: MIT

author:
  name: the-metafactory
  github: the-metafactory
  verified: true

description: >
  metafactory standard library — skills, pipelines, and components
  maintained by the core team.

artifacts:
  - path: skills/code-review
    description: Automated code review with configurable rulesets
  - path: skills/sop
    description: Standard operating procedure enforcement
  - path: pipelines/ecosystem-digest
    description: Cross-repo ecosystem status digest
  - path: pipelines/handover-digest
    description: Timezone handover summary pipeline
```

### Schema Rules

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `schema` | yes | `"arc/v1"` | Standard schema version |
| `name` | yes | string | Library name (used as install prefix) |
| `version` | yes | semver string | Library-level version (metadata only) |
| `type` | yes | `"library"` | New type value, distinguishes from single-artifact repos |
| `license` | no | string | SPDX license identifier |
| `author` | yes | object | Standard author block (name, github, verified) |
| `authors` | no | array | Additional authors |
| `description` | no | string | Human-readable library description |
| `artifacts` | yes | array | One or more artifact path entries |
| `artifacts[].path` | yes | string | Relative path from repo root to artifact directory |
| `artifacts[].description` | no | string | Short description (shown during interactive selection) |

The root manifest must NOT contain `provides`, `depends_on`, `capabilities`, or `scripts` — those belong on per-artifact manifests only. The root manifest is purely a directory listing.

---

## Per-Artifact Manifest

Each artifact subdirectory contains a standard `arc-manifest.yaml` with no schema changes. The existing `ArcManifest` interface handles these manifests exactly as it does today for standalone repos.

```yaml
# skills/code-review/arc-manifest.yaml
schema: arc/v1
name: code-review
version: 0.1.0
type: skill

author:
  name: the-metafactory
  github: the-metafactory
  verified: true

provides:
  skill:
    - trigger: "code review"
    - trigger: "review this PR"

depends_on:
  tools:
    - name: bun
      version: ">=1.0.0"

capabilities:
  filesystem:
    read: ["./"]
    write: []
  bash:
    allowed: true
    restricted_to: ["bun Tools/*.ts"]
```

Per-artifact manifests are validated identically to standalone package manifests. The artifact's `name` field is the artifact name — it does not need to be prefixed with the library name.

---

## Install Command Changes

### New Syntax

```bash
# Install all artifacts from a library
arc install mf-library

# Install a single artifact from a library
arc install mf-library:code-review

# Install from URL — if URL points to a library, prompt for selection
arc install https://github.com/the-metafactory/mf-library
```

The colon separator (`:`) distinguishes library-scoped installs from standalone installs. This mirrors the existing `parseDependencyRef()` pattern in `source-resolver.ts` which already uses colon as a type separator (`skill:Thinking`, `agent:Architect`).

### Install Flow (Library)

```
arc install mf-library:code-review
  1. Resolve source (registry lookup or URL)
  2. Git clone entire repo to ~/.config/metafactory/pkg/repos/mf-library/
  3. Read root arc-manifest.yaml → detect type: library
  4. Parse artifacts array → resolve requested artifact path
  5. Read artifact's arc-manifest.yaml (skills/code-review/arc-manifest.yaml)
  6. Display capabilities + risk level (per-artifact, not per-library)
  7. User confirms
  8. Create symlink from artifact subdir to ~/.claude/{skills,agents,commands,bin}/
  9. Record in packages.db (one InstalledSkill row per artifact)
  10. Run postinstall hooks (if declared in artifact manifest)
```

### Install All

When `arc install mf-library` is invoked (no artifact specified):

1. Clone repo, read root manifest
2. Iterate all entries in `artifacts` array
3. For each artifact: read manifest, display capabilities, confirm, symlink, record
4. User can skip individual artifacts during the confirmation step

### URL-Based Install

When `arc install <url>` detects a library root manifest:

1. Display the library name and artifact list with descriptions
2. Prompt: "Install all artifacts, or select specific ones?"
3. Proceed with selected artifacts

### Database Recording

Each artifact gets its own `InstalledSkill` row in `packages.db`:

| Field | Value |
|-------|-------|
| `name` | Artifact name (e.g., `code-review`) |
| `version` | Artifact version from its manifest |
| `repo_url` | Library repo URL |
| `install_path` | Path to artifact subdir in cloned repo |
| `skill_dir` | Symlink target in `~/.claude/` |
| `artifact_type` | From artifact manifest (skill, pipeline, etc.) |
| `install_source` | `library:mf-library` (provenance tracking) |

The `install_source` field uses the format `library:<library-name>` to record that the artifact was installed from a library. This enables library-level operations (list, remove).

---

## Source Resolver Changes

The `ResolvedSource` type in `types.ts` already has a `parentPath` field, which resolves the parent directory of the referenced file within a repo. For library support, we add a `subPath` field to track the artifact's subdirectory within the cloned repo.

### Type Change

```typescript
export interface ResolvedSource {
  type: "local" | "github";
  cloneUrl: string;
  org?: string;
  repo?: string;
  branch?: string;
  parentPath: string;
  filename: string;
  /** Artifact subdirectory within a library repo (undefined for standalone) */
  subPath?: string;
}
```

### Resolution Logic

The source resolver does not change how it clones repos — the entire repo is always cloned. The `subPath` field is set after clone when processing library artifacts:

1. Clone repo as usual (full repo to `~/.config/metafactory/pkg/repos/<name>/`)
2. Read root `arc-manifest.yaml` to detect library type
3. For each selected artifact, set `subPath` to the artifact's `path` value from the root manifest
4. All subsequent operations (manifest reading, symlink creation) use `repoRoot + subPath` as the base directory

The `resolveSource()` function in `source-resolver.ts` itself does not need to parse artifact names — that happens in the install command after the repo is cloned and the root manifest is read.

---

## Database Schema Changes

Add a `library_name` column to the `skills` table:

```sql
ALTER TABLE skills ADD COLUMN library_name TEXT;
```

This follows the existing migration pattern in `db.ts` (try ALTER, catch if column exists):

```typescript
try {
  db.exec(`ALTER TABLE skills ADD COLUMN library_name TEXT`);
} catch {
  // Column already exists
}
```

### Query Support

The `library_name` column enables library-scoped operations:

```bash
# List all artifacts from a library
arc list --library mf-library

# Remove all artifacts from a library
arc remove --library mf-library
```

SQL for library filtering:

```sql
-- List by library
SELECT * FROM skills WHERE library_name = ? ORDER BY name;

-- Remove by library
DELETE FROM skills WHERE library_name = ?;
```

---

## Registry Integration

`REGISTRY.yaml` entries for library artifacts include `library` and `path` fields to identify the artifact within the library repo:

```yaml
skills:
  - name: code-review
    description: Automated code review with configurable rulesets
    source: https://github.com/the-metafactory/mf-library
    type: community
    author: the-metafactory
    version: 0.1.0
    status: shipped
    library: mf-library
    path: skills/code-review
    sha256: a1b2c3d4e5f6...

  - name: sop
    description: Standard operating procedure enforcement
    source: https://github.com/the-metafactory/mf-library
    type: community
    author: the-metafactory
    version: 1.0.0
    status: shipped
    library: mf-library
    path: skills/sop
    sha256: f6e5d4c3b2a1...

pipelines:
  - name: ecosystem-digest
    description: Cross-repo ecosystem status digest
    source: https://github.com/the-metafactory/mf-library
    type: community
    author: the-metafactory
    version: 0.1.0
    status: shipped
    library: mf-library
    path: pipelines/ecosystem-digest
    sha256: 1a2b3c4d5e6f...
```

### SHA-256 Content Addressing (DD-61)

The `sha256` field contains the SHA-256 hash of the artifact's `arc-manifest.yaml` file. During install, if a registry entry includes `sha256`, arc verifies the hash of the fetched manifest against the registry value before proceeding. Hash mismatch aborts the install with a clear error.

Each artifact in a library has its own `sha256` — the hash is of the per-artifact manifest, not the root manifest.

---

## Directory Convention

```
mf-library/
  arc-manifest.yaml              # root: type=library, artifacts list
  skills/
    code-review/
      arc-manifest.yaml          # standard skill manifest
      skill/SKILL.md
      Tools/
        review.ts
    sop/
      arc-manifest.yaml          # standard skill manifest
      skill/SKILL.md
  pipelines/
    ecosystem-digest/
      arc-manifest.yaml          # standard pipeline manifest
      pipeline.yaml
      steps/
        ...
    handover-digest/
      arc-manifest.yaml          # standard pipeline manifest
      pipeline.yaml
      steps/
        ...
```

### Conventions

- Artifact subdirectories are grouped by type (`skills/`, `pipelines/`, `agents/`, etc.) but this is a convention, not a requirement. The `artifacts[].path` field is the authority.
- Each artifact directory is self-contained — it must work as if it were the root of a standalone repo.
- Shared code between artifacts in the same library is allowed but discouraged. If two artifacts share code, consider extracting it as a separate `component` artifact within the library.

---

## Backwards Compatibility

- **Single-package repos** (no `artifacts` field, type is not `library`) work exactly as before. The library detection path only activates when `type: library` is found in the root manifest.
- **`library` is a new type value.** Existing type values (`skill`, `system`, `tool`, `agent`, `prompt`, `component`, `pipeline`, `rules`) are unchanged. The `ArcManifest` interface's `type` union gains one new member.
- **No changes to per-artifact manifests.** Artifacts inside a library use the same `arc-manifest.yaml` schema as standalone packages.
- **Existing installed packages are not affected.** The `library_name` column is nullable — existing rows have `NULL` and all existing queries work unchanged.
- **The colon syntax is unambiguous.** `arc install foo` installs a standalone package or all of a library. `arc install foo:bar` installs artifact `bar` from library `foo`. There is no collision with existing install syntax.

---

## Versioning

Library support introduces a two-level versioning model:

| Level | Source | Purpose |
|-------|--------|---------|
| Library version | Root `arc-manifest.yaml` `version` field | Repo-level metadata; not used for install decisions |
| Artifact version | Per-artifact `arc-manifest.yaml` `version` field | What gets recorded in `packages.db`; used for upgrade checks |

### Upgrade Behavior

```bash
# Check each artifact's version independently
arc upgrade mf-library

# Upgrade a single artifact
arc upgrade mf-library:code-review

# --check reports per-artifact status
arc upgrade --check
```

When upgrading a library, arc:

1. `git pull` the library repo
2. Re-read each installed artifact's manifest
3. Compare artifact version against `packages.db` record
4. Upgrade only artifacts with version changes
5. Run per-artifact lifecycle hooks (`preupgrade`, `postupgrade`)

The library version is informational. It may be bumped when the library structure changes (e.g., new artifact added) but has no effect on individual artifact upgrade decisions.

---

## Migration Plan: Existing Repos to Library

These repos are candidates for consolidation into the first metafactory library:

| Repo | Type | Current Version |
|------|------|----------------|
| `ecosystem-digest` | pipeline | v0.1.0 |
| `handover-digest` | pipeline | v0.1.0 |
| `pai-skill-sop` | skill | v1.0.0 |
| `arc-skill-code-review` | skill | v0.1.0 |

### Migration Steps (per repo)

1. **Copy artifact directory structure into library repo.** Place the artifact under the appropriate type directory (e.g., `skills/code-review/`, `pipelines/ecosystem-digest/`).
2. **Verify `arc-manifest.yaml` in subdir is complete.** Ensure all fields are present and the manifest validates independently.
3. **Add artifact entry to root manifest.** Add `path` and `description` to the library's `artifacts` array.
4. **Test install.** Run `arc install mf-library:artifact-name` and verify symlinks, DB records, and capability audit.
5. **Archive original repo.** Set the standalone repo to read-only on GitHub. Add a notice in its README pointing to the library.
6. **Update REGISTRY.yaml entries.** Change `source` to the library repo URL and add `library` and `path` fields.

### Migration Order

1. Start with `ecosystem-digest` and `handover-digest` (both pipelines, both v0.1.0 — lowest risk).
2. Then `arc-skill-code-review` (skill, v0.1.0).
3. Finally `pai-skill-sop` (skill, v1.0.0 — most mature, migrate last to validate the pattern).

---

## Type Changes

The `ArcManifest` interface in `types.ts` needs `library` added to its `type` union:

```typescript
// Before
type: "skill" | "system" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "rules";

// After
type: "skill" | "system" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "rules" | "library";
```

A new interface for the library root manifest's artifact entries:

```typescript
/** An artifact entry in a library root manifest */
export interface LibraryArtifactEntry {
  path: string;
  description?: string;
}
```

The `ArcManifest` interface gains an optional `artifacts` field (only valid when `type` is `library`):

```typescript
/** Only present when type is "library" */
artifacts?: LibraryArtifactEntry[];
```

---

## Acceptance Criteria

- [ ] Library root manifest validates with `type: library` and `artifacts` array
- [ ] `arc install library:artifact` installs a single artifact from a library
- [ ] `arc install library` installs all artifacts from a library
- [ ] Each artifact tracked independently in `packages.db` with its own `InstalledSkill` row
- [ ] Capability audit runs per-artifact, not per-library
- [ ] `arc list` shows library provenance for library-sourced artifacts
- [ ] `arc remove library:artifact` removes a single artifact from a library
- [ ] `arc remove --library library-name` removes all artifacts from a library
- [ ] Single-package repos continue working unchanged (no regressions)
- [ ] SHA-256 verified when present in registry entry (DD-61)
- [ ] `library_name` column added to `skills` table via migration
- [ ] `arc upgrade library` checks each artifact's version independently
- [ ] `arc install <url>` detects library type and prompts for artifact selection
- [ ] `ResolvedSource.subPath` correctly resolves artifact subdirectories
