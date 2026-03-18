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
  warnings: AuditWarning[];
}

/**
 * Audit the total capability surface of all active installed skills.
 * Detects dangerous capability combinations.
 */
export function audit(db: Database): AuditResult {
  const allSkills = listSkills(db);
  const activeSkills = allSkills.filter((s) => s.status === "active");
  const caps = getAllActiveCapabilities(db);

  // Count capability surface
  const surface = {
    fs_read: caps.filter((c) => c.type === "fs_read").length,
    fs_write: caps.filter((c) => c.type === "fs_write").length,
    network: caps.filter((c) => c.type === "network").length,
    bash: caps.filter((c) => c.type === "bash").length,
    secret: caps.filter((c) => c.type === "secret").length,
  };

  // Detect dangerous combinations
  const warnings = detectDangerousCombinations(caps);

  return {
    totalSkills: allSkills.length,
    activeSkills: activeSkills.length,
    surface,
    warnings,
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
 */
export function formatAudit(result: AuditResult): string {
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

  if (result.warnings.length > 0) {
    lines.push(``);
    lines.push(`⚠️  Capability combination warnings:`);
    for (const w of result.warnings) {
      lines.push(`  - ${w.description}`);
    }
  } else {
    lines.push(``);
    lines.push(`No capability combination warnings.`);
  }

  return lines.join("\n");
}
