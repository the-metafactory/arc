import type { PaiPaths } from "../types.js";
import { loadSources, saveSources, getSourceType } from "../lib/sources.js";

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

  // Find target source
  let source;
  if (opts.sourceName) {
    source = config.sources.find((s) => s.name === opts.sourceName);
    if (!source) {
      return { success: false, error: `Source "${opts.sourceName}" not found` };
    }
  } else {
    source = config.sources.find((s) => getSourceType(s) === "metafactory");
    if (!source) {
      return { success: false, error: "No metafactory source configured" };
    }
  }

  // Validate type
  if (getSourceType(source) !== "metafactory") {
    return {
      success: false,
      error: `Source "${source.name}" is type "${getSourceType(source)}", not "metafactory".`,
    };
  }

  // Check token exists
  if (!source.token) {
    return { success: false, error: `Not logged in to ${source.name}` };
  }

  // Remove token
  delete source.token;
  await saveSources(opts.paths.sourcesPath, config);

  return { success: true, sourceName: source.name };
}
