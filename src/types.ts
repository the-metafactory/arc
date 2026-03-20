// pai-pkg core types

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
  type: "skill" | "system";
  tier?: "official" | "custom" | "community";
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
  };
  capabilities: Capabilities;
}

/** Installed skill record in packages.db */
export interface InstalledSkill {
  name: string;
  version: string;
  repo_url: string;
  install_path: string;
  skill_dir: string;
  status: "active" | "disabled";
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
}
