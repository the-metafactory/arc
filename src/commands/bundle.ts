import { resolve } from "path";
import { createBundle } from "../lib/bundle.js";
import type { PaiPaths } from "../types.js";

export interface BundleOptions {
  paths: PaiPaths;
  packageDir: string;
  outputPath?: string;
}

export interface BundleCommandResult {
  success: boolean;
  name?: string;
  version?: string;
  type?: string;
  tarballPath?: string;
  sha256?: string;
  sizeBytes?: number;
  fileCount?: number;
  warnings?: string[];
  error?: string;
}

/** Execute the arc bundle command */
export async function bundle(opts: BundleOptions): Promise<BundleCommandResult> {
  const packageDir = resolve(opts.packageDir);
  const outputPath = opts.outputPath ? resolve(opts.outputPath) : undefined;

  const result = await createBundle(packageDir, outputPath);

  if (!result.success) {
    return {
      success: false,
      warnings: result.warnings,
      error: result.error,
    };
  }

  return {
    success: true,
    name: result.manifest.name,
    version: result.manifest.version,
    type: result.manifest.type,
    tarballPath: result.tarballPath,
    sha256: result.sha256,
    sizeBytes: result.sizeBytes,
    fileCount: result.fileCount,
    warnings: result.warnings,
  };
}

/** Format bundle result for terminal output */
export function formatBundle(result: BundleCommandResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const sizeStr = formatSize(result.sizeBytes ?? 0);
  const lines = [
    `Bundled ${result.name} v${result.version}`,
    `  Type:     ${result.type}`,
    `  Files:    ${result.fileCount}`,
    `  Size:     ${sizeStr}`,
    `  SHA-256:  ${result.sha256}`,
    `  Output:   ${result.tarballPath}`,
  ];

  if (result.warnings?.length) {
    lines.push("");
    for (const w of result.warnings) {
      lines.push(`  Warning: ${w}`);
    }
  }

  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
