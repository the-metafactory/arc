import type { PaiPaths } from "../types.js";
import { loadSources, saveSources, findMetafactorySource } from "../lib/sources.js";

export interface LogoutOptions {
  paths: PaiPaths;
  sourceName?: string;
}

export interface LogoutResult {
  success: boolean;
  sourceName?: string;
  error?: string;
}

export async function logout(opts: LogoutOptions): Promise<LogoutResult> {
  const config = await loadSources(opts.paths.sourcesPath);

  const found = findMetafactorySource(config, opts.sourceName);
  if ("error" in found) {
    return { success: false, error: found.error };
  }
  const source = found.source;

  // Check token exists
  if (!source.token) {
    return { success: false, error: `Not logged in to ${source.name}` };
  }

  // Remove token
  delete source.token;
  await saveSources(opts.paths.sourcesPath, config);

  return { success: true, sourceName: source.name };
}
