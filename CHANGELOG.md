# Changelog

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
