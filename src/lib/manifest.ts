import { readFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import type { PaiManifest, RiskLevel } from "../types.js";

/**
 * Read and parse a pai-manifest.yaml from a directory.
 * Returns null if the file doesn't exist.
 * Throws if the file exists but is invalid.
 */
export async function readManifest(
  dir: string
): Promise<PaiManifest | null> {
  const manifestPath = join(dir, "pai-manifest.yaml");

  try {
    const content = await readFile(manifestPath, "utf-8");
    const parsed = YAML.parse(content) as PaiManifest;

    if (!parsed.name || !parsed.version || !parsed.capabilities) {
      throw new Error(
        `Invalid pai-manifest.yaml: missing required fields (name, version, capabilities)`
      );
    }

    return parsed;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Calculate risk level from capabilities.
 * - high: network + filesystem write, or secrets with network
 * - medium: network access, or secrets, or unrestricted bash
 * - low: filesystem only, or restricted bash
 */
export function assessRisk(manifest: PaiManifest): RiskLevel {
  const caps = manifest.capabilities;
  const hasNetwork = (caps.network?.length ?? 0) > 0;
  const hasFileWrite = (caps.filesystem?.write?.length ?? 0) > 0;
  const hasSecrets = (caps.secrets?.length ?? 0) > 0;
  const hasBash = caps.bash?.allowed === true;
  const bashRestricted = (caps.bash?.restricted_to?.length ?? 0) > 0;

  // High risk: network + write, or secrets + network
  if (hasNetwork && hasFileWrite) return "high";
  if (hasSecrets && hasNetwork) return "high";

  // Medium risk: network, secrets, or unrestricted bash
  if (hasNetwork) return "medium";
  if (hasSecrets) return "medium";
  if (hasBash && !bashRestricted) return "medium";

  return "low";
}

/**
 * Format capabilities for display with risk coloring.
 */
export function formatCapabilities(manifest: PaiManifest): string[] {
  const lines: string[] = [];
  const caps = manifest.capabilities;

  if (caps.filesystem?.read?.length) {
    for (const p of caps.filesystem.read) {
      lines.push(`  🟢 Read: ${p}`);
    }
  }
  if (caps.filesystem?.write?.length) {
    for (const p of caps.filesystem.write) {
      lines.push(`  🟡 Write: ${p}`);
    }
  }
  if (caps.network?.length) {
    for (const n of caps.network) {
      lines.push(`  🟡 Network: ${n.domain} (${n.reason})`);
    }
  }
  if (caps.bash?.allowed) {
    if (caps.bash.restricted_to?.length) {
      for (const b of caps.bash.restricted_to) {
        lines.push(`  🟡 Bash: ${b}`);
      }
    } else {
      lines.push(`  🔴 Bash: unrestricted`);
    }
  }
  if (caps.secrets?.length) {
    for (const s of caps.secrets) {
      lines.push(`  🟡 Secret: ${s}`);
    }
  }

  return lines;
}
