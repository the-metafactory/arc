# Changelog

## Unreleased

### Added

- **`arc nats add-federated-user <name> --account <A>` — scoped hub-transport user mint** (cortex#1598). Ensures ONE `federated`-role scoped signing key per account (subject-templated `federated.{{name()}}.>` sub scope + `federated.>` pub, hardwired — no permission flags), mints the user signed by it with no own permissions, exports 0600 creds. Probe-first idempotent on both halves; refuses to export a user signed by any other key (`USER_NOT_SCOPED`). New schema `arc.nats.federated-user.v1`; new error codes `SIGNING_KEY_FAILED`, `USER_NOT_SCOPED`. Documented in `docs/integrations/cortex-creds.md`.

### Fixed

- **`extractJwt` no longer captures a stray dash from real nsc creds output.** The decorated creds format uses six-dash END markers (`------END NATS USER JWT------`); the previous five-dash pattern lazily matched inside the marker and appended a `-` to the returned JWT (affects the `jwt` field of `add-bot`/`reissue-bot` JSON envelopes on real nsc output).

## 0.30.5

### Added

- **`type: process` is now a valid manifest type** ([#230](https://github.com/the-metafactory/arc/pull/230)). The arc manifest schema accepts process packages alongside the existing package types.
- **Library installs now respect artifact dependency ordering with atomic rollback** ([#231](https://github.com/the-metafactory/arc/pull/231)). Multi-artifact installs topologically order artifacts and roll back partial work when a later artifact fails.

### Fixed

- **Windows local repository paths no longer false-reject during install** ([#222](https://github.com/the-metafactory/arc/pull/222)). `extractRepoName` now treats Windows absolute paths as local paths and derives names with the active path flavor instead of POSIX-only `/` splitting.
- **Windows CLI shims are generated as `.cmd` launchers** ([#224](https://github.com/the-metafactory/arc/pull/224)). Installed tools are runnable through Windows `PATHEXT`, non-bun shim commands resolve relative to the bin directory, and removal cleans up both current `.cmd` shims and legacy extensionless shims.
- **PATH membership checks use platform-specific rules** ([#226](https://github.com/the-metafactory/arc/pull/226)). Windows shim-dir detection now splits on `;`, handles drive letters correctly, and compares path entries case-insensitively while preserving POSIX byte-sensitive behavior.

## 0.30.3

### Fixed

- **`arc install` of Sigstore-signed packages no longer fails on Windows** (closes [#216](https://github.com/the-metafactory/arc/issues/216), [#217](https://github.com/the-metafactory/arc/pull/217)). Two bugs in the cosign verification path:
  - `detectPlatform` excluded `win32` and built the binary name as `cosign-<process.platform>-<arch>` with no `win32`→`windows` mapping and no `.exe` suffix, so it never matched the real sigstore/cosign release asset (`cosign-windows-amd64.exe` / `cosign-windows-arm64.exe`). It now maps `win32`→`windows`, appends `.exe`, and accepts Windows as a supported target. `SUPPORTED_PLATFORMS` is derived from the os-name map's keys so the two can never drift.
  - A genuinely unsupported platform turned a verification *capability* gap into a hard install *failure* — `detectPlatform`'s throw propagated uncaught through `verifyPackageSigstore` and aborted the whole install. The verifier path now degrades to `verified: null` (warn-and-proceed, the same contract as unsigned and the soma#303 missing-identity case) while `--strict-signing` still escalates to a refusal. A genuine cosign rejection still returns `verified: false`.

## 0.30.0

### Fixed

- **Registry-extracted packages are upgradable again** (closes [#187](https://github.com/the-metafactory/arc/issues/187), [#188](https://github.com/the-metafactory/arc/pull/188)). Packages installed via `@scope/name` (e.g. `@metafactory/soma`) could not be upgraded three ways:
  - `arc upgrade <pkg> --check` falsely reported "up to date" — it resolved the advertised version through the YAML registry index (`findInAllSources`), but registry packages are published to the metafactory HTTP API. `checkUpgrades` now resolves those via `resolveFromRegistry`; git / YAML-registry packages keep the old path.
  - `arc upgrade <pkg> --force` errored `git pull failed: not a git repository` — a registry tarball has no `.git`. `upgradePackage` now detects registry packages and upgrades them by clean re-download + atomic swap. The new `fetchAndVerifyRegistryPackage` helper verifies with install parity (SHA-256 + Ed25519 registry signature + Sigstore).
  - The documented `remove`+`install` fallback could strand the user (remove succeeds, reinstall fails on a stale token). The registry upgrade now downloads and verifies **before** touching the working install and restores it on any failure, so an upgrade can never leave the user with no install.

- **CI green on Linux + eslint gate** ([#189](https://github.com/the-metafactory/arc/pull/189)). `createBundle` wrote the tarball into the package dir while archiving `.`, tripping GNU tar's "file changed as we read it" (exit 1) on Linux CI (bsdtar/macOS tolerated it); the archive is now staged in a temp dir outside the source tree and moved into place. Plus 8 mechanical eslint-gate fixes (unnecessary assertions/conditions, `Array<T>`→`T[]`, regex→`String#startsWith`).

## 0.27.1

### Fixed

- **`arc login` help text and install-time error are now actionable** (closes [#156](https://github.com/the-metafactory/arc/issues/156)).
  - `arc login` description previously claimed "required for publishing only"; install also needs authentication. Updated to "required for installs and publishing".
  - `arc logout` description likewise expanded to acknowledge that signed-in installs are affected.
  - 401/403 from a metafactory storage endpoint now hints at the next step: if no bearer was sent, `Run \`arc login\` first`; if a bearer was sent and rejected, `Token rejected — run \`arc login --force\` to refresh.` HTTP status code included for diagnosis.

## 0.24.0

### Changed

- **Multi-backend host adapter foundation (closes [#117](https://github.com/the-metafactory/arc/issues/117)).** 12-PR series ([#118–#129](https://github.com/the-metafactory/arc/pull/129)) splits the monolithic `PaiPaths` into two concerns: `ArcPaths` for arc's own host-independent state (config, db, repos, catalog) and `HostAdapter` + `HostPaths` for per-backend install dirs (Claude Code, Cortex). Phase 1 added the types and the Claude-Code adapter; Phase 2 introduced `hostPathFor()`/`requireHostDir()` dispatch and the Cortex adapter; Phase 3b migrated every production command (`verify`, `upgrade`, `install`, `remove`, `enable`, `disable`, `catalog`) command-by-command; this release (Phase 3d) deletes the deprecated `PaiPaths` type, `createPaths()` factory, and `TestEnv.paths` back-compat field, plus migrates the 5 remaining non-command callers (`info`, `login`, `logout`, `publish`, `review`, `bundle`).

### Removed

- **Breaking (TS only):** `PaiPaths` type, `createPaths()` factory, `TestEnv.paths` field. Replace with `ArcPaths` + `HostAdapter`. See `src/types.ts` and `test/helpers/test-env.ts` for the new shape.

### Notes

- Runtime behavior unchanged. Multi-host dispatch is wired but Claude Code remains the only default; future host adapters (Codex, Cursor) plug in via the `HostAdapter` interface without further surgery to commands.
- `ensureDirectories()` signature changed from `(paths: PaiPaths)` to `(arc: ArcPaths, host: HostAdapter)`.

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
