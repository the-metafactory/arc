import type { Database } from "bun:sqlite";
import { listSkills, getAllActiveCapabilities } from "../lib/db.js";
import type { AuditWarning, CapabilityRecord, RiskLevel } from "../types.js";

export interface AuditResult {
  totalSkills: number;
  activeSkills: number;
  surface: {
    fs_read: number;
    fs_write: number;
    network: number;
    bash: number;
    secret: number;
  };
  /** Per-skill capability breakdown */
  bySkill: Map<string, CapabilityRecord[]>;
  warnings: AuditWarning[];
  /** Warnings only between skills of different tiers/authors */
  crossTierWarnings: AuditWarning[];
}

/**
 * Audit the total capability surface of all active installed skills.
 * Detects dangerous capability combinations.
 */
export function audit(db: Database): AuditResult {
  const allSkills = listSkills(db);
  const activeSkills = allSkills.filter((s) => s.status === "active");
  const caps = getAllActiveCapabilities(db);

  // Build tier lookup from installed skills
  const tierBySkill = new Map<string, string>();
  for (const s of activeSkills) {
    tierBySkill.set(s.name, s.tier || "custom");
  }

  // Count capability surface
  const surface = {
    fs_read: caps.filter((c) => c.type === "fs_read").length,
    fs_write: caps.filter((c) => c.type === "fs_write").length,
    network: caps.filter((c) => c.type === "network").length,
    bash: caps.filter((c) => c.type === "bash").length,
    secret: caps.filter((c) => c.type === "secret").length,
  };

  // Group capabilities by skill
  const bySkill = new Map<string, CapabilityRecord[]>();
  for (const cap of caps) {
    const existing = bySkill.get(cap.skill_name) ?? [];
    existing.push(cap);
    bySkill.set(cap.skill_name, existing);
  }

  // Detect dangerous combinations
  const warnings = detectDangerousCombinations(caps);

  // Filter to cross-tier warnings only
  const crossTierWarnings = warnings.filter((w) => {
    const [a, b] = w.skills;
    return tierBySkill.get(a) !== tierBySkill.get(b);
  });

  return {
    totalSkills: allSkills.length,
    activeSkills: activeSkills.length,
    surface,
    bySkill,
    warnings,
    crossTierWarnings,
  };
}

/**
 * Detect dangerous capability combinations across skills.
 */
function detectDangerousCombinations(
  caps: CapabilityRecord[]
): AuditWarning[] {
  const warnings: AuditWarning[] = [];

  // Group capabilities by skill
  const bySkill = new Map<string, CapabilityRecord[]>();
  for (const cap of caps) {
    const existing = bySkill.get(cap.skill_name) ?? [];
    existing.push(cap);
    bySkill.set(cap.skill_name, existing);
  }

  // Get skills with specific capability types
  const networkSkills = new Set<string>();
  const writeSkills = new Set<string>();
  const secretSkills = new Set<string>();
  const readSkills = new Set<string>();

  for (const cap of caps) {
    if (cap.type === "network") networkSkills.add(cap.skill_name);
    if (cap.type === "fs_write") writeSkills.add(cap.skill_name);
    if (cap.type === "secret") secretSkills.add(cap.skill_name);
    if (cap.type === "fs_read") readSkills.add(cap.skill_name);
  }

  // Check: network + file write = download-and-write
  for (const netSkill of networkSkills) {
    for (const writeSkill of writeSkills) {
      if (netSkill !== writeSkill) {
        warnings.push({
          skills: [netSkill, writeSkill],
          capabilities: ["network", "fs_write"],
          description: `${netSkill} (network) + ${writeSkill} (file write) = download-and-write capability`,
          risk: "high",
        });
      }
    }
  }

  // Check: network + secret + file read = potential exfiltration
  for (const netSkill of networkSkills) {
    for (const readSkill of readSkills) {
      if (netSkill !== readSkill && secretSkills.has(netSkill)) {
        warnings.push({
          skills: [netSkill, readSkill],
          capabilities: ["network", "secret", "fs_read"],
          description: `${netSkill} (network + secret) + ${readSkill} (file read) = potential exfiltration path`,
          risk: "high",
        });
      }
    }
  }

  return warnings;
}

/**
 * Format audit results for console display.
 * Default: summary with cross-tier warnings only.
 * Verbose: full pairwise list of all warnings.
 */
export function formatAudit(result: AuditResult, verbose = false): string {
  const lines: string[] = [
    `Installed skills: ${result.totalSkills} (${result.activeSkills} active)`,
    ``,
    `Total capability surface:`,
    `  Filesystem read:  ${result.surface.fs_read} paths`,
    `  Filesystem write: ${result.surface.fs_write} paths`,
    `  Network:          ${result.surface.network} domains`,
    `  Bash:             ${result.surface.bash} patterns`,
    `  Secrets:          ${result.surface.secret} keys`,
  ];

  if (verbose) {
    // Per-skill capability breakdown
    lines.push(``);
    lines.push(`Per-skill capabilities:`);
    for (const [name, caps] of result.bySkill) {
      const types = caps.map((c) => c.type);
      const summary: string[] = [];
      const reads = caps.filter((c) => c.type === "fs_read").length;
      const writes = caps.filter((c) => c.type === "fs_write").length;
      const nets = caps.filter((c) => c.type === "network").length;
      const bashes = caps.filter((c) => c.type === "bash").length;
      const secrets = caps.filter((c) => c.type === "secret").length;
      if (reads) summary.push(`${reads} read`);
      if (writes) summary.push(`${writes} write`);
      if (nets) summary.push(`${nets} network`);
      if (bashes) summary.push(`${bashes} bash`);
      if (secrets) summary.push(`${secrets} secret`);
      lines.push(`  ${name}: ${summary.join(", ") || "none"}`);
    }

    // Full pairwise list
    if (result.warnings.length > 0) {
      lines.push(``);
      lines.push(`⚠️  All capability combination warnings (${result.warnings.length}):`);
      for (const w of result.warnings) {
        lines.push(`  - ${w.description}`);
      }
    } else {
      lines.push(``);
      lines.push(`No capability combination warnings.`);
    }
  } else {
    // Summary mode — group by pattern, show cross-tier only
    const downloadWrite = result.warnings.filter((w) =>
      w.capabilities.includes("fs_write") && w.capabilities.includes("network")
    );
    const exfiltration = result.warnings.filter((w) =>
      w.capabilities.includes("secret") && w.capabilities.includes("fs_read")
    );

    lines.push(``);
    lines.push(`Capability composition:`);
    if (downloadWrite.length > 0) {
      const netSkills = new Set(downloadWrite.map((w) => w.skills[0]));
      const writeSkills = new Set(downloadWrite.map((w) => w.skills[1]));
      lines.push(`  ${netSkills.size} network skills × ${writeSkills.size} file-write skills = ${downloadWrite.length} download-and-write paths`);
    }
    if (exfiltration.length > 0) {
      const netSkills = new Set(exfiltration.map((w) => w.skills[0]));
      const readSkills = new Set(exfiltration.map((w) => w.skills[1]));
      lines.push(`  ${netSkills.size} network+secret skills × ${readSkills.size} file-read skills = ${exfiltration.length} potential exfiltration paths`);
    }

    if (result.crossTierWarnings.length > 0) {
      lines.push(``);
      lines.push(`⚠️  Cross-tier warnings (${result.crossTierWarnings.length}):`);
      for (const w of result.crossTierWarnings) {
        lines.push(`  - ${w.description}`);
      }
    } else if (result.warnings.length > 0) {
      lines.push(``);
      lines.push(`All ${result.warnings.length} composition warnings are between same-tier skills (expected).`);
    } else {
      lines.push(``);
      lines.push(`No capability combination warnings.`);
    }

    if (result.warnings.length > 0) {
      lines.push(``);
      lines.push(`Run with --verbose to see all ${result.warnings.length} pairwise warnings.`);
    }
  }

  return lines.join("\n");
}
