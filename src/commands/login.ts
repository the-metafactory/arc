import type { PaiPaths } from "../types.js";
import { loadSources, saveSources, getSourceType } from "../lib/sources.js";
import { initiateDeviceCode, pollForToken, openBrowser } from "../lib/device-auth.js";

export interface LoginOptions {
  paths: PaiPaths;
  sourceName?: string;
  force?: boolean;
}

export interface LoginResult {
  success: boolean;
  sourceName?: string;
  scope?: string;
  expiresAt?: number;
  error?: string;
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
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
      return {
        success: false,
        error: "No metafactory source configured. Run: arc source add metafactory https://meta-factory.ai --type metafactory",
      };
    }
  }

  // Validate type
  if (getSourceType(source) !== "metafactory") {
    return {
      success: false,
      error: `Source "${source.name}" is type "${getSourceType(source)}", not "metafactory". Login is only for metafactory sources.`,
    };
  }

  // Check existing token
  if (source.token && !opts.force) {
    return {
      success: false,
      error: `Already logged in to ${source.name}. Use --force to re-authenticate.`,
    };
  }

  // Initiate device code flow
  let deviceCode;
  try {
    deviceCode = await initiateDeviceCode(source.url);
  } catch (err: any) {
    return {
      success: false,
      error: `Cannot reach ${source.url}: ${err.message}`,
    };
  }

  // Display code and open browser
  console.log(`\nVisit: ${deviceCode.verification_uri}`);
  console.log(`Enter code: ${deviceCode.user_code}\n`);

  if (!openBrowser(deviceCode.verification_uri)) {
    console.log("(Could not open browser automatically. Open the URL above manually.)");
  }

  // Poll for approval
  const result = await pollForToken(source.url, deviceCode.device_code, {
    interval: deviceCode.interval,
    expiresIn: deviceCode.expires_in,
    onPoll: (_attempt, elapsed) => {
      const remaining = deviceCode.expires_in - elapsed;
      process.stdout.write(`\rWaiting for approval... (${remaining}s remaining) `);
    },
  });

  // Clear the polling line
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  if (!result.success) {
    return {
      success: false,
      error: result.error ?? "Login failed",
    };
  }

  // Store token
  source.token = result.token;
  await saveSources(opts.paths.sourcesPath, config);

  return {
    success: true,
    sourceName: source.name,
    scope: result.scope,
    expiresAt: result.expiresAt,
  };
}
