# Changelog

## 0.22.0

### Added

- `PackageBuilder` § 12: **Persona-Driven Agents (Authoring Convention)**. Codifies the four-layer split (persona / skill bundle / built bundle / instance state), bundle-and-persona decoupling, blueprint contents, composition rules, authority-via-host-primitives, two-phase gates for irreversible operations, conformance checklist, and instance-vs-bundle separation. Aligns with the metafactory agent-platform design at [`forge/design/agent-platform.md`](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md). Closes [arc#100](https://github.com/the-metafactory/arc/issues/100), pairs with [grove#230](https://github.com/the-metafactory/grove/issues/230), part of [mf#390](https://github.com/the-metafactory/meta-factory/issues/390) Phase 4.
- New workflow `skill/Workflows/PublishBundle.md`: walks `arc bundle` -> `arc publish --dry-run` -> operator confirm -> `arc publish` -> `arc verify` round-trip. Two-phase gate at the dry-run step (halt for confirmation). Sha256 verification at the end; halt on mismatch.
- New workflow `skill/Workflows/AuthorPersonaAgent.md`: six-step walk (decide new vs reusable, scaffold new bundles, write workflow MDs, write persona, write manifest, wire host, verify conformance) for composing a persona-driven agent on top of one or more existing skill bundles.
- `triggers:` extended in `skill/SKILL.md` frontmatter with `author persona agent`, `persona-driven agent`, `compose blueprints`, `publish bundle`.

### Notes

- Docs-only release: no test suite covers SKILL.md or workflow markdown content. Existing `bun test` suite continues to pass; no behavior change in arc CLI.
- Out of scope (post-MVP): manifest signing (SkillSeal), `arc install --type agent` runtime flow. Tracked separately under [the-metafactory/meta-factory#389](https://github.com/the-metafactory/meta-factory/issues/389).

## 0.21.0

### Added
- `arc review` command family for sponsor / steward submission triage while the metafactory reviewer UI ([the-metafactory/meta-factory#114](https://github.com/the-metafactory/meta-factory/issues/114)) is still spec-only:
  - `arc review list` — pending submissions assigned to you (paginated, `--per-page` capped at 100 client-side, `--json` for scripting)
  - `arc review show <id>` — full submission detail; pretty-prints nested `validation_result` JSON
  - `arc review approve <id>` — advance submission to `approved` (first approval promotes package `draft` → `active`)
  - `arc review reject <id> -r <reason>` — reject with reason shown to publisher
  - `arc review request-changes <id> -m <message>` — request changes with comment to publisher
- All action commands accept `--json` for machine output.
- Reuses existing `arc login` bearer-token auth; `-s, --source <name>` selects a metafactory source. Server enforces tier-gating (`trusted+`), sponsor-only queue scoping, and DD-9 self-review prevention.

## 0.19.3

### Fixed
- `arc publish` rendered server errors as `[object Object]` when the registry returned a non-string `error` field (e.g. `{"error":{"message":"Internal server error"}}`). Added `formatServerError()` helper in `src/lib/publish.ts` that extracts `message`/`error` string fields or falls back to JSON — applied to uploadBundle, ensurePackageExists, and registerVersion error paths.

### Added
- `arc-manifest.yaml` at arc repo root (schema: arc/v1, type: tool), with `bundle.exclude` for `vendor/` (128MB cosign binary, fetched at build time via `scripts/fetch-cosign.ts`).

## 0.5.0

### Added
- **Lifecycle hooks**: `preinstall`, `preupgrade`, and `postupgrade` scripts in `arc-manifest.yaml`
  - `preinstall` runs before symlinks are created during first install
  - `preupgrade` runs before symlinks are updated during upgrade
  - `postupgrade` runs after symlinks + bun install during upgrade (falls back to `postinstall` if not declared)
  - Scripts receive `PAI_INSTALL_PATH` and `PAI_HOOK` env vars
  - Upgrade hooks also receive `PAI_OLD_VERSION` and `PAI_NEW_VERSION`
- Shared script runner (`src/lib/scripts.ts`) for consistent hook execution
- 10 new tests covering all lifecycle hook paths

### Fixed
- `upgrade.ts` crash when upgrading components without `capabilities` field (undefined guard)

## 0.4.0

### Added
- `scripts.postinstall` support in `arc-manifest.yaml`
- Component artifact type (`type: component`) for file-to-target symlink packages
- Optional `capabilities` field for components

## 0.3.0

### Added
- `arc self-update` command
- `arc upgrade --check` shows self-update availability
- Remote registry sources (apt-get style)

## 0.2.0

### Added
- Agent, prompt, and tool artifact types
- CLI shim generation for tools
- Path traversal guards
- Case-insensitive install lookup
- Comprehensive audit command

## 0.1.0

### Added
- Initial release: install, list, info, disable, enable, remove, verify
- Capability-based security model
- SQLite package database
