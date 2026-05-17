// arc core types

// ── Catalog types ──────────────────────────────────────────────

/** Artifact types in the catalog */
export type ArtifactType = "skill" | "agent" | "prompt" | "tool" | "component" | "pipeline" | "rules" | "library" | "action";

/** Catalog entry type — controls trust level and install behavior */
export type CatalogEntryType = "builtin" | "community" | "system" | "custom";

/** A single entry in catalog.yaml */
export interface CatalogEntry {
  name: string;
  description: string;
  source: string;
  type: CatalogEntryType;
  has_cli?: boolean;
  bundle?: boolean;
  requires?: string[]; // typed refs: "skill:Thinking", "agent:Architect"
}

/** Default directories for artifact installation */
export interface CatalogDefaults {
  skills_dir: string;
  agents_dir: string;
  prompts_dir: string;
  tools_dir: string;
  components_dir?: string;
}

/** Top-level catalog.yaml structure */
export interface CatalogConfig {
  defaults: CatalogDefaults;
  catalog: {
    skills: CatalogEntry[];
    agents: CatalogEntry[];
    prompts: CatalogEntry[];
    tools: CatalogEntry[];
    components?: CatalogEntry[];
    rules?: CatalogEntry[];
  };
}

// ── Registry types ────────────────────────────────────────────

/** A registry entry extends CatalogEntry with community metadata */
export interface RegistryEntry extends CatalogEntry {
  author: string;
  version?: string;
  status: "shipped" | "beta" | "deprecated";
  reviewed_by?: string[];
}

/** Top-level registry.yaml structure */
export interface RegistryConfig {
  registry: {
    skills: RegistryEntry[];
    agents: RegistryEntry[];
    prompts: RegistryEntry[];
    tools: RegistryEntry[];
    components?: RegistryEntry[];
    rules?: RegistryEntry[];
  };
}

/** Resolved source — output of source-resolver */
export interface ResolvedSource {
  type: "local" | "github";
  /** For local: absolute path to the parent directory. For github: clone URL */
  cloneUrl: string;
  /** GitHub org (undefined for local) */
  org?: string;
  /** GitHub repo name (undefined for local) */
  repo?: string;
  /** Git branch (undefined for local) */
  branch?: string;
  /** Path within the repo to the parent directory of the referenced file */
  parentPath: string;
  /** The filename referenced in the source URL */
  filename: string;
  /** Artifact subdirectory within a library repo (undefined for standalone) */
  subPath?: string;
}

/** Capability declarations from arc-manifest.yaml */
export interface Capabilities {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  network?: { domain: string; reason: string }[];
  bash?: {
    allowed: boolean;
    restricted_to?: string[];
  };
  secrets?: string[];
  skills?: string[];
  mcp?: string[];
  hooks?: string[];
}

/** Skill dependency declaration */
export interface SkillDependency {
  name: string;
  version?: string;
  reason?: string;
}

/** Tool dependency declaration */
export interface ToolDependency {
  name: string;
  version?: string;
  reason?: string;
}

/** Package dependency — another arc managed package */
export interface PackageDependency {
  name: string;
  repo: string;
}

/** CLI tool provided by a skill */
export interface CliProvider {
  command: string;
  name?: string;
}

/** Skill trigger declaration */
export interface SkillTrigger {
  trigger: string;
}

/** Template declaration for rules packages */
export interface RulesTemplate {
  /** Path to template file within the package (e.g., "templates/CLAUDE.md.template") */
  source: string;
  /** Output file name in the consumer repo (e.g., "CLAUDE.md") */
  target: string;
  /** Config file in consumer repo (e.g., "claude-md.yaml") */
  config: string;
  /** Only generate if consumer opts in via their generate list */
  optional?: boolean;
}

/** Rules config schema (claude-md.yaml in consumer repo) */
export interface RulesConfig {
  template: string;
  generate?: { format: string }[];
  sections?: { position: string; file: string }[];
  extra_labels?: { name: string }[];
  /** Placeholder values — any key not in the above is a placeholder */
  [key: string]: unknown;
}

/**
 * Runtime declaration for type:agent packages.
 *
 * Per cortex `docs/design-arc-agent-bots.md` §4. Names the substrate
 * (claude-code / codex / pi-dev / custom) and the supervision mode
 * (in-process under cortex's runner, or standalone as its own daemon).
 * Capabilities are register-on-start values published to NATS KV by
 * the bot's daemon — listed here so cortex can scope credentials and
 * the dashboard can render an accurate provenance badge.
 */
export interface AgentRuntime {
  // The `& {}` trick preserves autocomplete for the known literals while
  // still accepting arbitrary strings (custom substrate names). Without it,
  // the union collapses to `string` and tooling loses the known-literal hints.
  substrate:
    | "claude-code"
    | "codex"
    | "pi-dev"
    | "custom-binary"
    | (string & {});
  mode: "in-process" | "standalone";
  capabilities?: string[];
}

/**
 * Identity declaration for type:agent packages.
 *
 * Rendered into the cortex fragment (`~/.config/cortex/agents.d/<id>.yaml`)
 * by the CortexHostAdapter. The `trust` list is propagated to the
 * runtime's `TrustResolver` — every id MUST resolve in the merged
 * `AgentRegistry` at construction time (cortex `docs/design-arc-agent-bots.md`
 * §9, registry.ts §9.3 rule 1).
 */
export interface AgentIdentity {
  id: string;
  did?: string;
  displayName?: string;
  roles?: string[];
  trust?: string[];
}

/**
 * Ordered lifecycle script arrays for `type: agent` packages.
 *
 * Sister field to the existing `scripts.{preinstall,postinstall,…}` single-
 * script shape. The array form is required for standalone-bot install
 * sequences where order matters (cortex `docs/design-arc-agent-bots.md`
 * §8.1 / §8.2): drop fragment → signal cortex reload → issue NATS creds →
 * (standalone only) launchctl load. Uninstall reverses.
 *
 * Each entry is a path relative to the package install root, exactly like
 * the single-script `scripts` fields. Both shapes may be present on the
 * same manifest; arc runs `scripts.<phase>` first, then `lifecycle.<phase>`
 * in declared order. A failure in any entry aborts the install and
 * triggers the same rollback path as the single-script form.
 */
export interface LifecycleScripts {
  preinstall?: string[];
  postinstall?: string[];
  preuninstall?: string[];
  postuninstall?: string[];
}

/** Inline hook array format (e.g. Grove) */
export interface InlineHook {
  event: string;
  command: string;
  matcher?: string;
}

/** Config-file hook format (e.g. Miner) — references a JSON file */
export interface HooksConfigRef {
  claude_code: {
    config: string;
    description?: string;
  };
}

/** Union of both hook declaration formats in arc-manifest.yaml */
export type HooksDeclaration = InlineHook[] | HooksConfigRef;

/** An artifact entry in a library root manifest */
export interface LibraryArtifactEntry {
  path: string;
  description?: string;
}

/** Extension declaration in arc-manifest.yaml */
export interface ExtensionEntry {
  source: string;
  name: string;
}

/** The full arc-manifest.yaml schema (also accepts legacy pai-manifest.yaml) */
export interface ArcManifest {
  schema?: "arc/v1" | "pai/v1";
  name: string;
  version: string;
  type: "skill" | "system" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "rules" | "library";
  /** Only present when type is "library" — lists contained artifacts */
  artifacts?: LibraryArtifactEntry[];
  /**
   * Multi-target install destinations (arc#117 multi-backend HostAdapter).
   *
   * When absent, arc routes to the single host adapter passed in
   * InstallOptions (today: claude-code). When present, arc dispatches
   * once per declared target in the order required by the artifact's
   * design contract — for `type: agent` standalone bots, that means
   * `cortex` FIRST, then the OS-supervision host (`darwin-launchd` or
   * `linux-systemd`) per cortex `docs/design-arc-agent-bots.md` §3.2.
   */
  targets?: HostId[];
  /**
   * Runtime declaration — type:agent only. Names substrate + supervision
   * mode + capabilities. Required for type:agent packages that declare
   * `targets: [cortex, …]`. See AgentRuntime.
   */
  runtime?: AgentRuntime;
  /**
   * Identity declaration — type:agent only. Rendered into the cortex
   * agent fragment. See AgentIdentity.
   */
  identity?: AgentIdentity;
  tier?: PackageTier;
  author?: {
    name: string;
    github: string;
    verified?: boolean;
  };
  authors?: {
    name: string;
    github: string;
    verified?: boolean;
  }[];
  provides?: {
    skill?: SkillTrigger[];
    cli?: CliProvider[];
    files?: { source: string; target: string }[];
    templates?: RulesTemplate[];
    hooks?: HooksDeclaration;
    /**
     * Standalone-bot daemon binary, relative to the package install root.
     * Rendered into the OS-supervision host's binDir (`~/bin/<binary>` on
     * darwin-launchd) at install time. type:agent + runtime.mode=standalone only.
     */
    binary?: string;
    /**
     * macOS launchd plist template, relative to the package install root.
     * Rendered into `~/Library/LaunchAgents/<label>.plist` by the
     * darwin-launchd HostAdapter, with token substitution (e.g.,
     * `{{NATS_URL}}`, `{{BIN}}`, `{{LOG_DIR}}`).
     */
    plist?: string;
    /**
     * Linux systemd user unit template, relative to the package install root.
     * Rendered into `~/.config/systemd/user/<unit>.service` by the
     * linux-systemd HostAdapter (post-P6).
     */
    systemdUnit?: string;
  };
  extensions?: {
    statusline?: ExtensionEntry[];
  };
  depends_on?: {
    skills?: SkillDependency[];
    tools?: ToolDependency[];
    packages?: PackageDependency[];
  };
  capabilities?: Capabilities;
  scripts?: {
    preinstall?: string;
    postinstall?: string;
    preupgrade?: string;
    postupgrade?: string;
    /** Runs before `arc remove` tears down symlinks / hooks / repo. Used to
     *  stop daemons, unload launchd plists, etc. */
    preremove?: string;
  };
  /**
   * Ordered lifecycle script arrays — for sequences where order matters
   * (e.g. type:agent standalone bots: signal-reload → issue-creds →
   * launchctl-load). Runs after the single-script `scripts` field of the
   * same phase. See LifecycleScripts.
   */
  lifecycle?: LifecycleScripts;
  /** Optional namespace for publishing (alternative to account default) */
  namespace?: string;
  /** Bundle configuration for arc publish */
  bundle?: BundleConfig;
  /** Package description */
  description?: string;
  /** SPDX license identifier */
  license?: string;
  /**
   * Canonical source repository URL. Forwarded to the metafactory registry
   * at publish time so the package landing page can resolve relative README
   * image paths against the repo's raw content
   * (the-metafactory/meta-factory#501).
   *
   * Common shapes accepted by the registry's `extractRepoSlug`:
   *   - `https://github.com/owner/repo[.git]`
   *   - `git+https://github.com/owner/repo.git`
   *   - `git@github.com:owner/repo.git`
   *   - `github:owner/repo`
   *   - `owner/repo`
   */
  repository?: string;
  /** Optional public homepage / docs URL. Forwarded as-is to the registry. */
  homepage?: string;
  /** Free-form search keywords. Forwarded to the registry for discovery. */
  keywords?: string[];
  /**
   * Discovery category. The registry pins an enumeration —
   * `text-processing | security | api-integration | data-ops | devtools |
   * research | communication | infrastructure` — but arc forwards the raw
   * string and lets the server validate, so the source of truth stays in
   * one place.
   */
  category?: string;
}

/** Trust tier for installed packages */
export type PackageTier = "official" | "community" | "custom";

/** Source type discriminator: registry (YAML file) or metafactory (API) */
export type SourceType = "registry" | "metafactory";

/** A configured registry source (apt-get style) */
export interface RegistrySource {
  name: string;
  url: string;
  tier: PackageTier;
  enabled: boolean;
  /** Source type. Defaults to "registry" when absent (backward compat). */
  type?: SourceType;
  /** Bearer token for authenticated API access. Only used with type "metafactory". */
  token?: string;
}

/** Top-level sources.yaml structure */
export interface SourcesConfig {
  sources: RegistrySource[];
}

/** Response from POST /api/v1/auth/cli/initiate */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Response from POST /api/v1/auth/cli/verify */
export interface DeviceVerifyResponse {
  status: "pending" | "approved" | "denied";
  token?: string;
  token_id?: string;
  scope?: string;
  expires_at?: number;
  expires_in?: number;
}

/** Result of the complete device code auth flow */
export interface DeviceAuthResult {
  success: boolean;
  token?: string;
  expiresAt?: number;
  scope?: string;
  error?: string;
  errorCode?: "expired" | "denied" | "timeout" | "network" | "no_source" | "wrong_type";
}

/** Package summary from metafactory API list endpoint */
export interface MetafactoryPackageListItem {
  namespace: string;
  name: string;
  display_name: string | null;
  description: string | null;
  type: string;
  license: string;
  latest_version: string | null;
  publisher: {
    display_name: string | null;
    tier: string | null;
    mfa_enabled: boolean;
  };
  created_at: number;
  updated_at: number;
}

/** Paginated list response from metafactory API */
export interface MetafactoryPackageListResponse {
  packages: MetafactoryPackageListItem[];
  total: number;
  page: number;
  per_page: number;
}


/** Detailed package info from metafactory API */
export interface MetafactoryPackageDetail {
  namespace: string;
  name: string;
  display_name: string | null;
  description: string | null;
  type: string;
  license: string;
  latest_version: string | null;
  versions: string[];
  publisher: {
    display_name: string | null;
    tier: string | null;
    mfa_enabled: boolean;
    github_username: string | null;
  };
  sponsor: { display_name: string; tier: string; github_username: string | null } | null;
  created_at: number;
  updated_at: number;
}

/** A search result annotated with its source */
export interface SourcedSearchResult {
  entry: RegistryEntry;
  artifactType: ArtifactType;
  sourceName: string;
  sourceTier: PackageTier;
}

/** Search command options */
export interface SearchOptions {
  keyword?: string;
  json?: boolean;
  type?: ArtifactType;
  tier?: PackageTier;
}

/** Warning about a source that failed during search */
export interface SearchWarning {
  sourceName: string;
  reason: "unreachable" | "auth_required" | "rate_limited" | "malformed";
  message: string;
  usedStaleCache: boolean;
}

/** Search result with metadata and warnings */
export interface SearchResult {
  results: SourcedSearchResult[];
  warnings: SearchWarning[];
  totalSources: number;
  successfulSources: number;
}

/** Parsed package reference from CLI input */
export interface PackageRef {
  scope: string;
  name: string;
  version?: string;
}

/** SHA-256 verification result */
export interface VerifyResult {
  valid: boolean;
  expected: string;
  actual: string;
}

/** Installed package record in packages.db (skills and tools) */
export interface InstalledSkill {
  name: string;
  version: string;
  repo_url: string;
  install_path: string;
  skill_dir: string;
  status: "active" | "disabled";
  artifact_type: ArtifactType;
  tier: PackageTier;
  customization_path: string | null;
  install_source: string | null;
  /** Library name when this artifact was installed from a library (null for standalone) */
  library_name: string | null;
  installed_at: string;
  updated_at: string;
}

/** Capability entry in packages.db */
export interface CapabilityRecord {
  skill_name: string;
  type: "fs_read" | "fs_write" | "network" | "bash" | "secret" | "skill_dep";
  value: string;
  reason: string;
}

/** Risk level for capability display */
export type RiskLevel = "low" | "medium" | "high";

/** Audit warning for dangerous capability combinations */
export interface AuditWarning {
  skills: string[];
  capabilities: string[];
  description: string;
  risk: RiskLevel;
}

// ── Host adapter types (multi-backend support, see issue #117) ─────
// Two concerns:
//   - ArcPaths: arc's own state, host-independent
//   - HostPaths + HostAdapter: per-backend install dirs and behavior

/**
 * Supported agentic backends. The union expands when each adapter lands so
 * the type stays truthful: a value of `HostId` should always correspond to
 * an actually implemented `HostAdapter`. Phase 2 of #117 adds `"codex"`,
 * `"cursor"`, etc. as those adapters arrive.
 *
 * `darwin-launchd` and `linux-systemd` are OS-supervision hosts for
 * standalone-bot type:agent packages — they receive the daemon binary and
 * a launchd plist (macOS) or systemd user unit (Linux). See cortex
 * `docs/design-arc-agent-bots.md` §3.2 and arc#140. The adapter for
 * `darwin-launchd` lands in P2 of arc#140; `linux-systemd` later (Phase C
 * of the design doc). Schema declares the union so a `targets:` value can
 * be parsed and validated even before its adapter is registered.
 */
export type HostId =
  | "claude-code"
  | "cortex"
  | "darwin-launchd"
  | "linux-systemd";

/** Set of all known HostId values — for runtime validation of `targets:`. */
export const KNOWN_HOST_IDS: readonly HostId[] = [
  "claude-code",
  "cortex",
  "darwin-launchd",
  "linux-systemd",
] as const;

/** arc's own state — host-independent. Lives under ~/.config/metafactory/. */
export interface ArcPaths {
  /** Config root (~/.config/metafactory/) */
  configRoot: string;
  /** Package repos (~/.config/metafactory/pkg/repos/) */
  reposDir: string;
  /** Remote registry cache directory (~/.config/metafactory/pkg/cache/) */
  cachePath: string;
  /** Database path (~/.config/metafactory/packages.db) */
  dbPath: string;
  /** Sources config path (~/.config/metafactory/sources.yaml) */
  sourcesPath: string;
  /** Secrets directory (~/.config/metafactory/secrets/) */
  secretsDir: string;
  /** Runtime state (~/.config/metafactory/skills/) */
  runtimeDir: string;
  /** Pipelines directory (~/.config/metafactory/pipelines/) */
  pipelinesDir: string;
  /** Actions directory (~/.config/metafactory/actions/) */
  actionsDir: string;
  /** PATH-accessible shim directory (~/bin/) — shared across hosts */
  shimDir: string;
  /** Catalog file path (repo-root/catalog.yaml) */
  catalogPath: string;
  /** Registry file path (repo-root/registry.yaml) */
  registryPath: string;
}

/** Per-host install paths. Different backends place artifacts in different roots. */
export interface HostPaths {
  /** Host root (e.g. ~/.claude/, ~/.codex/, ~/.cursor/) */
  root: string;
  /** Skills directory (e.g. ~/.claude/skills/, ~/.codex/skills/) */
  skillsDir: string;
  /** Agents directory (Claude Code only today) */
  agentsDir: string;
  /** Slash commands/prompts directory */
  promptsDir: string;
  /** Tool bin directory (e.g. ~/.claude/bin/) */
  binDir: string;
  /** Host settings file (e.g. ~/.claude/settings.json, ~/.codex/config.toml) */
  settingsPath: string;
}

/**
 * Cortex-host-only path extensions. Not promoted to `HostPaths` because no
 * other backend has the same concepts (personas are cortex-specific; NATS
 * creds live in a NATS-conventional location). Cortex's adapter exposes
 * these as `HostPaths & CortexPaths` so cortex-aware callers see them while
 * generic dispatch (`hostPathFor`, `requireHostDir`) keeps working off the
 * base `HostPaths` surface.
 *
 * See cortex `docs/design-arc-agent-bots.md` §6.2 "Note on `HostPaths` extension".
 */
export interface CortexPaths {
  /** Persona markdown files for in-process bots (~/.config/cortex/personas/). */
  personasDir: string;
  /** Per-agent NATS user creds, daemon-written (~/.config/nats/creds/). */
  credsDir: string;
}

/**
 * Cortex host's concrete `paths` shape — base `HostPaths` plus cortex-only
 * extensions. Use this when you've already narrowed `host.id === "cortex"`.
 */
export type CortexHostPaths = HostPaths & CortexPaths;

/**
 * darwin-launchd-host-only path extensions. Standalone-bot daemons land
 * their plist into the user's `~/Library/LaunchAgents/` directory; arc
 * uses `plistDir` instead of overloading the base `settingsPath` because
 * the plist directory is a *collection*, not a single config file. The
 * binary lands in the base `binDir` field.
 *
 * Same pattern as `CortexPaths` — not promoted to `HostPaths` because no
 * other adapter has a comparable concept (cortex's `personasDir`,
 * `credsDir`; launchd's `plistDir`).
 *
 * See cortex `docs/design-arc-agent-bots.md` §3.2 and arc#140 P2.
 */
export interface LaunchdPaths {
  /** macOS user LaunchAgents directory (~/Library/LaunchAgents/). */
  plistDir: string;
}

/**
 * darwin-launchd host's concrete `paths` shape. Use this when you've
 * already narrowed `host.id === "darwin-launchd"`.
 */
export type DarwinLaunchdHostPaths = HostPaths & LaunchdPaths;

/**
 * linux-systemd-host-only path extensions. Sister to LaunchdPaths for the
 * macOS / Linux OS-supervision split. Standalone-bot daemons land their
 * unit file into the user-scope systemd directory (`~/.config/systemd/user/`).
 *
 * See cortex `docs/design-arc-agent-bots.md` §3.2 platform note and
 * arc#140 P6.
 */
export interface SystemdPaths {
  /** Linux user systemd directory (~/.config/systemd/user/). */
  unitDir: string;
}

/**
 * linux-systemd host's concrete `paths` shape. Use this when you've
 * already narrowed `host.id === "linux-systemd"`.
 */
export type LinuxSystemdHostPaths = HostPaths & SystemdPaths;

/**
 * Host adapter — describes one agentic backend (Claude Code, Codex CLI, Cursor, …).
 *
 * Phase 1 (this PR): interface + Claude-Code default implementation. No dispatch yet.
 * Phase 2: install/remove dispatch moves through `installArtifact()` and `removeArtifact()`.
 * Phase 3: per-host MCP writers (out of scope for #117).
 */
export interface HostAdapter {
  id: HostId;
  /** True when this host is installed/configured on the system. */
  detect(): boolean;
  /** Per-host install paths. */
  paths: HostPaths;
  /**
   * Whether this host *recognizes* the given artifact type.
   *
   * Note: `supports(type) === true` does NOT imply
   * `hostPathFor(host, type) !== null`. Some types (`component`, `rules`,
   * `library`) are recognized but don't install into a host directory —
   * `hostPathFor()` returns `null` for them. The two predicates answer
   * different questions; never bridge them.
   */
  supports(type: ArtifactType): boolean;
}

// ── Bundle and publish types ─────────────────────────────────

/** Bundle exclusion configuration (from arc-manifest.yaml) */
export interface BundleConfig {
  exclude?: string[];
  include?: string[];
}

/** Result of tarball creation */
export interface BundleResult {
  success: boolean;
  tarballPath: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  manifest: ArcManifest;
  warnings: string[];
  error?: string;
}

/** Manifest validation for publishing (stricter than install) */
export interface PublishValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  name: string;
  version: string;
}

/** Result of R2 storage upload */
export interface UploadResult {
  success: boolean;
  sha256: string;
  r2Key: string;
  sizeBytes: number;
  error?: string;
}

/** Result of version registration */
export interface RegisterResult {
  success: boolean;
  versionId?: string;
  error?: string;
  statusCode?: number;
}

/** Result of package existence check/creation */
export interface EnsurePackageResult {
  exists: boolean;
  created: boolean;
  error?: string;
}
