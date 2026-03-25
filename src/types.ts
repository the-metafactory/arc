// pai-pkg core types

// ── Catalog types ──────────────────────────────────────────────

/** Artifact types in the catalog */
export type ArtifactType = "skill" | "agent" | "prompt" | "tool";

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
}

/** Top-level catalog.yaml structure */
export interface CatalogConfig {
  defaults: CatalogDefaults;
  catalog: {
    skills: CatalogEntry[];
    agents: CatalogEntry[];
    prompts: CatalogEntry[];
    tools: CatalogEntry[];
  };
}

// ── Registry types ────────────────────────────────────────────

/** A registry entry extends CatalogEntry with community metadata */
export interface RegistryEntry extends CatalogEntry {
  author: string;
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
}

/** Capability declarations from pai-manifest.yaml */
export interface Capabilities {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  network?: Array<{ domain: string; reason: string }>;
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

/** Package dependency — another pai-pkg managed package */
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

/** The full pai-manifest.yaml schema */
export interface PaiManifest {
  name: string;
  version: string;
  type: "skill" | "system" | "tool" | "agent" | "prompt";
  tier?: PackageTier;
  author: {
    name: string;
    github: string;
    verified?: boolean;
  };
  provides?: {
    skill?: SkillTrigger[];
    cli?: CliProvider[];
  };
  depends_on?: {
    skills?: SkillDependency[];
    tools?: ToolDependency[];
    packages?: PackageDependency[];
  };
  capabilities: Capabilities;
}

/** Trust tier for installed packages */
export type PackageTier = "official" | "community" | "custom";

/** A configured registry source (apt-get style) */
export interface RegistrySource {
  name: string;
  url: string;
  tier: PackageTier;
  enabled: boolean;
}

/** Top-level sources.yaml structure */
export interface SourcesConfig {
  sources: RegistrySource[];
}

/** A search result annotated with its source */
export interface SourcedSearchResult {
  entry: RegistryEntry;
  artifactType: ArtifactType;
  sourceName: string;
  sourceTier: PackageTier;
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

/** Configurable paths — injected for test isolation */
export interface PaiPaths {
  /** Root of ~/.claude equivalent */
  claudeRoot: string;
  /** Skills directory (~/.claude/skills/) */
  skillsDir: string;
  /** Agents directory (~/.claude/agents/) */
  agentsDir: string;
  /** Prompts/commands directory (~/.claude/commands/) */
  promptsDir: string;
  /** Bin directory (~/.claude/bin/) */
  binDir: string;
  /** Package repos (~/.config/pai/pkg/repos/) */
  reposDir: string;
  /** Database path (~/.config/pai/packages.db) */
  dbPath: string;
  /** Config root (~/.config/pai/) */
  configRoot: string;
  /** Secrets directory (~/.config/pai/secrets/) */
  secretsDir: string;
  /** Runtime state (~/.config/pai/skills/) */
  runtimeDir: string;
  /** PATH-accessible shim directory (~/bin/) */
  shimDir: string;
  /** Catalog file path (repo-root/catalog.yaml) */
  catalogPath: string;
  /** Registry file path (repo-root/registry.yaml) */
  registryPath: string;
  /** Sources config path (~/.config/pai/sources.yaml) */
  sourcesPath: string;
  /** Remote registry cache directory (~/.config/pai/pkg/cache/) */
  cachePath: string;
}
