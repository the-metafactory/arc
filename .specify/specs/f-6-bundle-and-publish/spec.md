---
id: "F-6"
feature: "bundle-and-publish"
status: "specified"
created: "2026-04-12"
specified: "2026-04-12"
mode: "batch"
---

# Specification: Bundle and Publish

## Overview

Add `arc bundle` and `arc publish` commands to create distributable tarballs from packages and upload them to the metafactory registry. This is the publisher-side complement to F-4 (install from registry) — completing the end-to-end package lifecycle.

**Phase 1 (this spec):** Uses the existing bootstrap API (`POST /api/v1/packages/:scope/:name/versions`) with bearer token auth. Creates tarballs locally, computes SHA-256, uploads to R2 via the storage endpoint, and registers the version.

**Phase 2 (future, DD-97):** Migrates to the `/intake/v1/` seam contract with Sigstore keyless OIDC, presigned R2 uploads, and the full intake pipeline.

### Dependencies

- F-2 (device-code-auth-flow) — Bearer token for authenticated uploads
- F-3 (registry-api-client) — API client for metafactory endpoints
- metafactory `POST /api/v1/storage/upload` — R2 content-addressed upload
- metafactory `POST /api/v1/packages/:scope/:name/versions` — version registration

### Symmetry with F-4

| F-4 (Install) | F-6 (Publish) |
|----------------|---------------|
| `parsePackageRef(@scope/name)` | Read scope/name from manifest |
| `downloadPackage(url, token)` | `uploadPackage(tarball, token)` |
| `verifyChecksum(file, expected)` | `computeChecksum(file)` → send expected |
| `extractPackage(tarball, dir)` | `createTarball(dir)` → tarball |

## User Scenarios

### Scenario 1: Bundle a package

**As a** package author in a directory with arc-manifest.yaml
**I want** to run `arc bundle` to create a distributable tarball
**So that** I can inspect what will be published before uploading

**Acceptance Criteria:**
- **Given** the current directory (or specified path) contains arc-manifest.yaml
- **When** I run `arc bundle`
- **Then** arc reads the manifest and validates it
- **And** arc creates a `.tar.gz` in the current directory named `{name}-{version}.tar.gz`
- **And** arc computes and displays the SHA-256 hash
- **And** arc displays the bundle contents summary (file count, total size, artifact type)
- **And** arc warns about files that should not be published (.git, node_modules, .env, etc.)

### Scenario 2: Bundle with output path

**As a** package author who wants the tarball in a specific location
**I want** to specify an output path
**So that** I can control where the bundle is created

**Acceptance Criteria:**
- **When** I run `arc bundle --output /tmp/my-package.tar.gz`
- **Then** the tarball is written to the specified path
- **And** all other behavior is identical to Scenario 1

### Scenario 3: Publish a package (two-step: bundle + upload)

**As a** package author ready to publish
**I want** to run `arc publish` to bundle and upload in one step
**So that** I don't need to manually bundle then upload

**Acceptance Criteria:**
- **Given** I am authenticated (`arc login` completed, token in sources.yaml)
- **And** the current directory contains arc-manifest.yaml
- **When** I run `arc publish`
- **Then** arc creates the tarball (same as `arc bundle`)
- **And** arc uploads the tarball to `POST /api/v1/storage/upload`
- **And** arc receives the R2 key and server-confirmed SHA-256
- **And** arc verifies client SHA-256 matches server SHA-256
- **And** arc registers the version via `POST /api/v1/packages/:scope/:name/versions`
- **And** arc displays success with version, SHA-256, and registry URL
- **And** the temp tarball is cleaned up

### Scenario 4: Publish from a pre-built bundle

**As a** package author who already ran `arc bundle`
**I want** to publish from the existing tarball
**So that** I can review the bundle before publishing

**Acceptance Criteria:**
- **When** I run `arc publish --tarball ./my-package-1.0.0.tar.gz`
- **Then** arc reads the manifest from inside the tarball (without re-bundling)
- **And** arc uploads and registers using the existing tarball
- **And** the original tarball is preserved (not cleaned up)

### Scenario 5: Publish requires authentication

**As a** user who hasn't logged in
**I want** a clear error telling me to authenticate
**So that** I understand why publish failed

**Acceptance Criteria:**
- **Given** no token exists for any metafactory source
- **When** I run `arc publish`
- **Then** arc fails with: `Not authenticated. Run "arc login" first.`
- **And** no tarball is uploaded

### Scenario 6: Version already exists (DD-14 immutability)

**As a** package author publishing a version that already exists
**I want** a clear error explaining immutability
**So that** I know to bump the version

**Acceptance Criteria:**
- **Given** version 1.0.0 of my package already exists in the registry
- **When** I run `arc publish` with version 1.0.0 in my manifest
- **Then** arc fails with: `Version 1.0.0 already published. Bump version in arc-manifest.yaml. Published versions are immutable (DD-14).`

### Scenario 7: Library type packages

**As a** library author with multiple artifacts
**I want** to bundle the entire library as one tarball
**So that** install can discover and install individual artifacts from it

**Acceptance Criteria:**
- **Given** the package has `type: library` with an `artifacts` array in the manifest
- **When** I run `arc bundle`
- **Then** arc creates a single tarball containing the root manifest and all artifact subdirectories
- **And** arc validates each artifact's sub-manifest exists
- **And** the bundle summary shows the library name and lists constituent artifacts

**Note:** The install side (`installLibrary()` in install.ts) already handles extracting individual artifacts from a library directory. The tarball just needs to preserve the directory structure. Per-artifact tarballs are out of scope — one tarball per library, matching the git-clone model.

### Scenario 8: Dry run

**As a** package author who wants to validate before publishing
**I want** to see what would happen without actually uploading
**So that** I can catch issues before they hit the registry

**Acceptance Criteria:**
- **When** I run `arc publish --dry-run`
- **Then** arc creates the tarball and computes SHA-256
- **And** arc validates the manifest against metafactory/v1 schema
- **And** arc displays what would be published (name, version, type, sha256, size, file count)
- **And** arc does NOT upload anything
- **And** the temp tarball is cleaned up

## Functional Requirements

### FR-1: Tarball creation (`createBundle`)

Create a `.tar.gz` from a package directory, excluding files that should not be published.

**Implementation:** Shell out to `tar czf` via `Bun.spawn`. No archive library dependency — system `tar` is available on all target platforms (macOS, Linux) and matches the extraction path in F-4's `extractPackage()` which also uses system `tar`. This keeps the install/publish symmetry clean.

```typescript
interface BundleResult {
  success: boolean;
  tarballPath: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  manifest: ArcManifest;
  warnings: string[];
  error?: string;
}

async function createBundle(
  packageDir: string,
  outputPath?: string,
): Promise<BundleResult>
```

**Tarball structure:** The tarball contains all included files rooted at the package directory name. When extracted with `tar xzf --strip-components=1`, the result is the package contents flat in the target directory. This matches F-4's `extractPackage()` expectations.

**Excluded patterns** (two-tier: hardcoded defaults + manifest overrides):

Default exclusions (always applied):
- `.git/` — version control
- `node_modules/` — dependencies (installed via `bun install` post-extract)
- `.env`, `.env.*` — secrets
- `*.db`, `*.sqlite` — local databases
- `.DS_Store`, `Thumbs.db` — OS artifacts
- `.specify/` — spec tooling
- `test/`, `tests/` — test files (not needed at runtime)
- `dist/` — build output (consumers build locally)
- `*.log` — log files
- `.wrangler/` — Cloudflare dev artifacts
- `.claude/` — Claude Code project files

Manifest-level overrides via optional `bundle` key in arc-manifest.yaml:
```yaml
bundle:
  exclude:          # additional patterns to exclude (appended to defaults)
    - "fixtures/"
    - "*.test.ts"
  include:          # override defaults to force-include specific paths
    - "test/fixtures/"   # e.g., a skill that ships test fixtures
```

The `include` list takes precedence over both default and custom `exclude` patterns. This replaces `.arcignore` — keeping config in the manifest avoids a new config file.

**Size limits:**
- Client-side pre-check: reject if tarball > 50MB (matches server `MAX_PACKAGE_SIZE` in `meta-factory/src/lib/storage.ts`)
- Warning at > 10MB (most packages should be well under this)

**Warnings** (displayed but not blocking):
- No README.md found (publish will still succeed, but package page will lack docs)
- Tarball exceeds 10MB
- Manifest has no `description` field

**Validation:** Unit test with mock package directory; test exclusion patterns; test manifest `bundle.exclude`/`include` overrides.

### FR-2: Manifest validation for publishing

Before bundling, validate the manifest meets publishing requirements (stricter than install-time validation):

- `name` is present and valid (lowercase alphanumeric + hyphens)
- `version` is valid semver
- `type` is a recognized artifact type
- `description` is present (warning if missing, not blocking)

**Scope derivation:** The scope (namespace) for publishing is resolved in this order:
1. Explicit `--scope` flag on the CLI (e.g., `arc publish --scope mellanon`)
2. `namespace` field in arc-manifest.yaml (if present)
3. Fetched from `GET /api/v1/auth/me` — the account's reserved namespace

Step 3 requires a metafactory API change: add `namespace` to the `/auth/me` response (the `accounts` table already has this column, it's just not exposed). This is a one-line change in `meta-factory/src/index.ts:188`. Until that lands, steps 1 or 2 are required — arc errors with: `Cannot determine publish scope. Add namespace to arc-manifest.yaml or use --scope.`

```typescript
interface PublishValidation {
  valid: boolean;
  errors: string[];     // blocking
  warnings: string[];   // informational
  scope?: string;       // resolved from CLI, manifest, or API
  name: string;
  version: string;
}

async function resolvePublishScope(
  manifest: ArcManifest,
  source: RegistrySource,
  cliScope?: string,
): Promise<string | null>

function validateForPublish(manifest: ArcManifest): PublishValidation
```

**Validation:** Unit tests with valid/invalid manifests; test scope resolution order.

### FR-3: Upload to R2 storage

Upload the tarball to the metafactory storage endpoint. The server computes SHA-256 and returns the R2 key.

```typescript
interface UploadResult {
  success: boolean;
  sha256: string;       // server-confirmed hash
  r2Key: string;        // content-addressed R2 path
  sizeBytes: number;
  error?: string;
}

async function uploadBundle(
  tarballPath: string,
  source: RegistrySource,
): Promise<UploadResult>
```

**Flow:**
1. Read tarball as ArrayBuffer
2. `POST /api/v1/storage/upload` with Bearer token and raw body
3. Server returns `{ sha256, r2_key, size_bytes }`
4. Client compares server SHA-256 with locally computed SHA-256
5. If mismatch: abort, report corruption (do not proceed to version registration)

**Validation:** Unit test with mocked storage endpoint.

### FR-4: Version registration

Register the uploaded version with the package registry.

```typescript
interface RegisterResult {
  success: boolean;
  versionId?: string;
  error?: string;
  statusCode?: number;
}

async function registerVersion(
  source: RegistrySource,
  scope: string,
  name: string,
  payload: {
    version: string;
    sha256: string;
    r2_key: string;
    manifest: ArcManifest;
    size_bytes: number;
    readme?: string;
  },
): Promise<RegisterResult>
```

**Flow:**
1. `POST /api/v1/packages/@{scope}/{name}/versions` with Bearer token
2. Body: `{ version, sha256, r2_key, manifest, size_bytes, readme }`
3. Server validates manifest (F-300), checks immutability (DD-14)
4. Returns version ID on success

**Error mapping:**
- 409 Conflict → version already published (DD-14)
- 400 Bad Request → manifest validation failed (show server errors)
- 403 Forbidden → namespace not owned by user
- 404 Not Found → package doesn't exist; `ensurePackageExists()` (FR-5) handles this automatically before version registration

**Validation:** Unit test with mocked API.

### FR-5: Package creation (if needed)

If the package doesn't exist in the registry yet, create it before registering the version.

```typescript
async function ensurePackageExists(
  source: RegistrySource,
  scope: string,
  name: string,
  manifest: ArcManifest,
): Promise<{ exists: boolean; created: boolean; error?: string }>
```

**Flow:**
1. `GET /api/v1/packages/@{scope}/{name}` — check if exists
2. If 404: `POST /api/v1/packages` with `{ namespace: scope, name, type, description }`
3. If exists: return existing

**Validation:** Unit test with create and exists paths.

### FR-6: README extraction

Extract README.md from the package directory and include it in the version registration payload as **raw markdown**. The server renders HTML via `renderReadme()` (CP-7, DD-81). If no README is found, the field is omitted (null) — the server accepts this and the package page shows a "no README" fallback. This is a warning, not a blocker.

```typescript
async function extractReadme(packageDir: string): Promise<string | null>
```

Looks for (in order): `README.md`, `readme.md`, `Readme.md`. Returns raw markdown string or null.

### FR-7: Source resolution for publish

The `--source` flag selects which metafactory source to publish to. Default: use `findMetafactorySource()` from `src/lib/sources.ts` — same logic as `arc login`. This returns the first enabled metafactory-type source. Error if no metafactory source exists: `No metafactory source configured. Add one with: arc source add metafactory https://meta-factory.ai --type metafactory`.

### FR-8: Temp file management

All temp tarballs use a `withTempDir()` helper that guarantees cleanup via `try/finally`:

```typescript
async function withTempDir<T>(
  fn: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "arc-publish-"));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

Located in `src/lib/bundle.ts` alongside tarball creation. When `--tarball` is used (publish from existing bundle), the original tarball is NOT cleaned up — only temp files created by arc are managed.

### FR-9: CLI commands

**`arc bundle [path]`**

```
Options:
  --output, -o <path>   Output tarball path (default: ./{name}-{version}.tar.gz)

Output:
  Bundled @scope/name v1.0.0
    Type:     skill
    Files:    12
    Size:     24.3 KB
    SHA-256:  abc123...def456
    Output:   ./my-skill-1.0.0.tar.gz
```

**`arc publish [path]`**

```
Options:
  --tarball, -t <path>  Publish from existing tarball (skip bundling)
  --dry-run             Validate and show what would be published, but don't upload
  --source <name>       Use specific metafactory source (default: first metafactory source)
  --scope <namespace>   Override publish scope (default: from manifest or account)

Output (dry run):
  [DRY RUN] Would publish @scope/name v1.0.0
    Type:     skill
    Files:    12
    Size:     24.3 KB
    SHA-256:  abc123...def456
    Source:   metafactory (https://meta-factory.ai)

Output (actual):
  Publishing @scope/name v1.0.0 to metafactory...
    Uploading tarball (24.3 KB)... done
    Verifying SHA-256... matched
    Registering version... done

  Published @scope/name v1.0.0
    SHA-256:  abc123...def456
    URL:      https://meta-factory.ai/package/@scope/name
```

### FR-10: No local DB tracking for publishes (deliberate)

Publishing is a server-side operation — the registry is the source of truth for what's published. Adding a local `publish_history` table would create a stale mirror. If `arc list --published` is needed later, it should query the registry API (`GET /api/v1/packages?publisher=me`), not a local DB. This is explicitly deferred, not forgotten.

## Non-Functional Requirements

- **Security:** Bearer tokens never logged. Tarball never contains `.env` or secrets. SHA-256 verified client-side vs server-side — mismatch aborts. Temp tarballs cleaned up on all code paths (success and failure).
- **Performance:** Tarball creation uses `tar czf` via Bun.spawn — fast for typical package sizes (< 50MB). Upload timeout: 120 seconds. Version registration timeout: 10 seconds.
- **Reliability:** If upload succeeds but version registration fails, arc automatically retries registration once. If the retry also fails, display the error and advise re-running `arc publish` — the upload endpoint returns 409 for duplicate content (DD-14 immutability), so re-uploading the same tarball is safe and idempotent. No `--r2-key` recovery flag needed. SHA-256 double-check (client vs server) catches upload corruption.
- **Usability:** `--dry-run` validates everything without side effects. Clear error messages with suggested recovery. Progress feedback during upload.

## Error Handling

| Error Condition | Trigger | User-Facing Message | Recovery |
|----------------|---------|---------------------|----------|
| No manifest | Missing arc-manifest.yaml | `No arc-manifest.yaml found in {path}. Run "arc init" to create one.` | `arc init` |
| Invalid manifest | Validation failures | `Manifest validation failed:\n  - {errors}` | Fix manifest |
| Not authenticated | No token | `Not authenticated. Run "arc login" first.` | `arc login` |
| SHA-256 mismatch | Client != server hash | `Upload integrity check failed. Client and server SHA-256 do not match. Do not proceed — this may indicate data corruption in transit.` | Retry |
| Version exists | 409 from server | `Version {v} already published. Bump version in arc-manifest.yaml. (DD-14)` | Bump version |
| Namespace not owned | 403 from server | `You do not own namespace @{scope}. Check your account at meta-factory.ai.` | Contact admin |
| Upload too large | > 50MB (client pre-check before upload) | `Package exceeds 50MB limit ({size}). Reduce package size or add exclusions via bundle.exclude in arc-manifest.yaml.` | Add exclusions or reduce content |
| Network error | Connection failure | `Upload failed: {error}. Check your connection and try again.` | Retry |

## Key Entities

| Entity | Description | Key Attributes |
|--------|-------------|----------------|
| `BundleResult` | Result of tarball creation | tarballPath, sha256, sizeBytes, fileCount, manifest, warnings |
| `UploadResult` | Result of R2 upload | sha256 (server), r2Key, sizeBytes |
| `RegisterResult` | Result of version registration | versionId, success |
| `PublishValidation` | Manifest check for publishing | valid, errors, warnings, scope, name, version |

## Implementation Plan

### New files

| File | Purpose |
|------|---------|
| `src/commands/bundle.ts` | `arc bundle` command |
| `src/commands/publish.ts` | `arc publish` command |
| `src/lib/bundle.ts` | Tarball creation, exclusion patterns, manifest validation for publish |
| `src/lib/publish.ts` | Upload, version registration, package creation |

### Modified files

| File | Change |
|------|--------|
| `src/cli.ts` | Register `bundle` and `publish` commands |

### Test files

| File | Coverage |
|------|----------|
| `test/unit/bundle.test.ts` | Tarball creation, exclusions, manifest `bundle.exclude`/`include`, library bundling |
| `test/commands/bundle.test.ts` | CLI integration for bundle |
| `test/commands/publish.test.ts` | CLI integration for publish (mocked API) |

### Test strategy (addressing CI vs manual gate)

**CI tests (automated):** All tests use mocked HTTP endpoints via intercepted fetch or fixture responses. No real metafactory instance required. Covers: tarball creation, exclusion logic, manifest validation, upload/register request shaping, error handling, temp cleanup.

**Manual gate (pre-release):** The "full round-trip" in the success criteria is a manual verification: `arc publish` from a real package directory against the staging metafactory instance, then `arc install @scope/name` on a clean machine. This is a release gate, not a CI test — it requires a running metafactory with auth credentials. Document the manual test procedure in the PR description.

## Success Criteria

- [ ] `arc bundle` creates a valid .tar.gz from a package directory
- [ ] `arc bundle` excludes .git, node_modules, .env, etc.
- [ ] `arc bundle` computes and displays SHA-256
- [ ] `arc publish` uploads tarball to R2 storage
- [ ] `arc publish` verifies client SHA-256 matches server SHA-256
- [ ] `arc publish` registers version via API
- [ ] `arc publish` handles version immutability (409) gracefully
- [ ] `arc publish --dry-run` validates without uploading
- [ ] `arc publish --tarball` publishes from existing bundle
- [ ] Authentication required for publish (not for bundle)
- [ ] README.md included in version registration payload
- [ ] All existing tests still pass
- [ ] New tests cover bundle creation, upload, registration, error paths

## Assumptions

| Assumption | What Would Invalidate It | Detection Strategy |
|-----------|-------------------------|-------------------|
| `POST /api/v1/storage/upload` accepts raw tarball body | Server expects multipart or different format | Integration test against staging |
| Server returns `{ sha256, r2_key, size_bytes }` from upload | Different response shape | Test against real API |
| `POST /api/v1/packages/:scope/:name/versions` accepts manifest as JSON | Server expects different encoding | Test against real API |
| Publisher's namespace matches their account | Namespace claiming is separate | Check package creation flow |
| Package can be auto-created on first publish | Must be created separately | Test 404 → create flow |

## System Context

### Upstream Dependencies

| System | What We Get | What Breaks If It Changes | Version/Contract |
|--------|-------------|---------------------------|------------------|
| F-2 (device-code-auth-flow) | Bearer token in sources.yaml | Cannot authenticate uploads | Merged |
| metafactory storage API | `POST /api/v1/storage/upload` → `{ sha256, r2_key }` | Cannot upload tarballs | Bootstrap API |
| metafactory package API | `POST /api/v1/packages/:scope/:name/versions` | Cannot register versions | Bootstrap API |
| arc-manifest.yaml | Package metadata (name, version, type, capabilities) | Cannot determine what to publish | A-100 (done) |

### Downstream Consumers

| System | What They Expect | Breaking Change Threshold |
|--------|-----------------|--------------------------|
| F-4 (install from registry) | Tarball format extractable by `tar xzf --strip-components=1` | Tarball structure change |
| metafactory submission workflow | version registered → submission created → sponsor review | API contract change |
| `arc verify` | SHA-256 in registry matches what was uploaded | Hash computation change |

## Out of Scope

- Sigstore signing (Phase 2, DD-97 seam contract)
- `/intake/v1/` endpoint migration (Phase 2)
- Presigned R2 direct uploads (Phase 2 — currently uploads through the Worker)
- Bundle publishing (library-type packages with multiple artifacts) — separate feature
- `.arcignore` file — replaced by `bundle.exclude`/`bundle.include` in arc-manifest.yaml
- Submission tracking (`arc submissions status/follow`) — separate feature after publish works

## Migration Path to Phase 2 (DD-97)

This spec is designed for easy migration to the seam contract:

| Phase 1 (this spec) | Phase 2 (DD-97) |
|----------------------|-----------------|
| Bearer token auth | Sigstore keyless OIDC |
| `POST /api/v1/storage/upload` (through Worker) | Presigned R2 URL (direct upload) |
| `POST /api/v1/packages/.../versions` | `POST /intake/v1/submissions` + `IntakeEnvelopeV1` |
| No submission tracking | `arc submissions status/follow` with SSE |
| Client bundles tarball only | Client bundles tarball + Sigstore bundle + Rekor UUID |

The `createBundle()` function and tarball format remain identical. Only the upload and registration protocol changes.

## Open Questions

| Question | Impact | Owner |
|----------|--------|-------|
| ~~Does `POST /api/v1/storage/upload` return the R2 key in the response?~~ **RESOLVED:** Yes, returns `{ sha256, r2_key, size_bytes }` (201). Duplicate content returns 409. | — | Verified in `meta-factory/src/routes/storage.ts:101-108` |
| ~~Should `arc publish` auto-create the package if it doesn't exist?~~ **RESOLVED:** Yes. FR-5 `ensurePackageExists()` auto-creates on first publish. The metafactory `POST /api/v1/packages` endpoint supports this — it checks namespace ownership (DD-15) and creates the package record. No separate step needed. | — | Luna review R2, verified against packages.ts:500-600 |
| ~~Should we support `.arcignore` in Phase 1?~~ **RESOLVED:** No separate file. Use `bundle.exclude`/`bundle.include` in arc-manifest.yaml instead. Keeps config in one place. | — | Luna review feedback |
| ~~What's the namespace claiming flow for new publishers?~~ **RESOLVED:** Namespace reservation is part of the metafactory onboarding flow (identity verification + sponsor approval grants IDENTIFIED tier and reserves a namespace in the `namespace_reservations` table). `arc publish` checks namespace ownership via `ensurePackageExists()` → the server returns 403 if the namespace isn't owned. Error message: `You do not own namespace @{scope}. Complete identity verification at meta-factory.ai.` This is a prerequisite, not a bug — DD-3 and DD-9 require identity verification before publishing. | — | Verified against packages.ts:551-559 and namespace_reservations schema |

## Review Incorporation Log

| Finding | Source | Resolution |
|---------|--------|------------|
| #1: No tarball utilities | Luna (#61) | Specified: shell out to system `tar` via `Bun.spawn` — matches F-4 extraction path |
| #2: Exclusion patterns incomplete | Luna (#61) | Expanded defaults (dist/, *.log, .wrangler/, .claude/); added manifest-level `bundle.exclude`/`bundle.include` |
| #3: Library type bundles | Luna (#61) | Added Scenario 7: one tarball per library, preserves directory structure for `installLibrary()` |
| #4: 409 UX underspecified | Luna (#61) | Error message already in Scenario 6 and error table — verified explicit |
| #5: --source flag default | Luna (#61) | Added FR-7: uses `findMetafactorySource()` from sources.ts (same as login) |
| #6: Package size limits | Luna (#61) | Client-side 50MB pre-check (matches server MAX_PACKAGE_SIZE); 10MB warning |
| #7: README format | Luna (#61) | Clarified: raw markdown sent to server, server renders HTML (CP-7); missing README is warning not blocker |
| #8: Temp file cleanup | Luna (#61) | Added FR-8: `withTempDir()` helper with try/finally guarantee |
| #9: No DB for publishes | Luna (#61) | Added FR-10: deliberate decision — registry is source of truth, local DB would be stale mirror |
| #10: Test strategy | Luna (#61) | Split: CI tests use mocked HTTP; round-trip is manual release gate against staging instance |
| #11: Scope derivation underspecified | Luna R2 (#61) | FR-2: three-tier resolution (--scope flag > manifest namespace > /auth/me API). Needs one-line metafactory change to expose namespace |
| #12: FR-5 vs Open Questions contradiction | Luna R2 (#61) | Resolved OQ: yes, auto-create on first publish via ensurePackageExists() |
| #13: --create flag doesn't exist | Luna R2 (#61) | Removed from FR-4 error mapping; FR-5 auto-creates, no flag needed |
| #14: No retry for partial publish | Luna R2 (#61) | Auto-retry registration once; re-running arc publish is safe (upload is idempotent via DD-14) |
| #15: Namespace claiming blocker | Luna R2 (#61) | Resolved OQ: namespace reserved during onboarding (DD-3/DD-9); 403 error with clear guidance |
