import { readFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import type { ArcManifest, RiskLevel } from "../types.js";

/** Preferred manifest filename (new name). */
export const MANIFEST_FILENAME = "arc-manifest.yaml";

/** Legacy manifest filename (still recognized). */
export const LEGACY_MANIFEST_FILENAME = "pai-manifest.yaml";

/** Both manifest filenames, preferred first. */
export const MANIFEST_FILENAMES = [MANIFEST_FILENAME, LEGACY_MANIFEST_FILENAME] as const;

/**
 * Read and parse an arc-manifest.yaml (or legacy pai-manifest.yaml) from a directory.
 * Prefers arc-manifest.yaml; falls back to pai-manifest.yaml.
 * Returns null if neither file exists.
 * Throws if a file exists but is invalid.
 */
export async function readManifest(
  dir: string
): Promise<ArcManifest | null> {
  for (const filename of MANIFEST_FILENAMES) {
    const manifestPath = join(dir, filename);
    try {
      const content = await readFile(manifestPath, "utf-8");
      const parsed = YAML.parse(content) as ArcManifest;

      if (!parsed.name || !parsed.version) {
        throw new Error(
          `Invalid ${filename}: missing required fields (name, version)`
        );
      }

      // Library-specific validation
      if (parsed.type === "library") {
        validateLibraryManifest(parsed, filename);
        return parsed;
      }

      // capabilities optional for component and rules types, required for others
      if (!parsed.capabilities && parsed.type !== "component" && parsed.type !== "rules") {
        throw new Error(
          `Invalid ${filename}: missing required field 'capabilities' (only optional for type: component)`
        );
      }

      return parsed;
    } catch (err: any) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

/**
 * Validate a library root manifest.
 * Libraries must have an artifacts array and must NOT have provides/capabilities/scripts.
 */
function validateLibraryManifest(parsed: ArcManifest, filename: string): void {
  if (!parsed.artifacts || !Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
    throw new Error(
      `Invalid ${filename}: library type requires a non-empty 'artifacts' array`
    );
  }

  // Root manifest must not contain per-artifact fields
  if (parsed.provides) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'provides' (belongs on per-artifact manifests)`
    );
  }
  if (parsed.capabilities) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'capabilities' (belongs on per-artifact manifests)`
    );
  }
  if (parsed.scripts) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'scripts' (belongs on per-artifact manifests)`
    );
  }

  // Validate each artifact entry
  for (const artifact of parsed.artifacts) {
    if (!artifact.path || typeof artifact.path !== "string") {
      throw new Error(
        `Invalid ${filename}: each artifact must have a 'path' string`
      );
    }
    // Path traversal guard
    if (artifact.path.includes("..") || artifact.path.startsWith("/")) {
      throw new Error(
        `Invalid ${filename}: artifact path '${artifact.path}' must be relative and cannot contain '..'`
      );
    }
  }
}

/**
 * Read artifact manifests from a library repo.
 * Returns an array of [artifactEntry, manifest] pairs for valid artifacts.
 */
export async function readLibraryArtifacts(
  libraryDir: string,
  manifest: ArcManifest,
): Promise<Array<{ entry: import("../types.js").LibraryArtifactEntry; manifest: ArcManifest }>> {
  if (manifest.type !== "library" || !manifest.artifacts) {
    return [];
  }

  const results: Array<{ entry: import("../types.js").LibraryArtifactEntry; manifest: ArcManifest }> = [];

  for (const entry of manifest.artifacts) {
    const artifactDir = join(libraryDir, entry.path);
    const artifactManifest = await readManifest(artifactDir);
    if (!artifactManifest) {
      throw new Error(
        `Library artifact '${entry.path}' has no arc-manifest.yaml`
      );
    }
    if (artifactManifest.type === "library") {
      throw new Error(
        `Library artifact '${entry.path}' cannot itself be a library`
      );
    }
    results.push({ entry, manifest: artifactManifest });
  }

  return results;
}

/**
 * Calculate risk level from capabilities.
 * - high: network + filesystem write, or secrets with network
 * - medium: network access, or secrets, or unrestricted bash
 * - low: filesystem only, or restricted bash
 */
export function assessRisk(manifest: ArcManifest): RiskLevel {
  const caps = manifest.capabilities ?? {};
  if (!manifest.capabilities) return "low";
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
export function formatCapabilities(manifest: ArcManifest): string[] {
  const lines: string[] = [];
  const caps = manifest.capabilities ?? {};
  if (!manifest.capabilities) return lines;

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
