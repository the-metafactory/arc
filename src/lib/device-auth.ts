import type { DeviceCodeResponse, DeviceVerifyResponse, DeviceAuthResult } from "../types.js";

interface PollOptions {
  interval: number;
  expiresIn: number;
  onPoll?: (attempt: number, elapsed: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initiate device code flow against a metafactory API.
 * POST /api/v1/auth/cli/initiate
 */
export async function initiateDeviceCode(baseUrl: string): Promise<DeviceCodeResponse> {
  const url = `${baseUrl}/api/v1/auth/cli/initiate`;
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Initiate failed: ${response.status} ${body}`.trim());
  }

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Poll for token approval.
 * POST /api/v1/auth/cli/verify with device_code
 */
export async function pollForToken(
  baseUrl: string,
  deviceCode: string,
  opts: PollOptions,
): Promise<DeviceAuthResult> {
  const url = `${baseUrl}/api/v1/auth/cli/verify`;
  const intervalMs = opts.interval * 1000;
  const deadline = Date.now() + opts.expiresIn * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = Math.floor((Date.now() - (deadline - opts.expiresIn * 1000)) / 1000);
    opts.onPoll?.(attempt, elapsed);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 410) {
        return { success: false, error: "Device code expired", errorCode: "expired" };
      }

      if (response.status === 202) {
        await sleep(intervalMs);
        continue;
      }

      if (response.ok) {
        const body = (await response.json()) as DeviceVerifyResponse;

        if (body.status === "approved" && body.token) {
          return {
            success: true,
            token: body.token,
            expiresAt: body.expires_at,
            scope: body.scope,
          };
        }

        if (body.status === "denied") {
          return { success: false, error: "Login denied", errorCode: "denied" };
        }

        // status: "pending" on 200 -- keep polling
        await sleep(intervalMs);
        continue;
      }

      // Unexpected status
      await sleep(intervalMs);
    } catch {
      // Network error -- retry, don't abort
      await sleep(intervalMs);
    }
  }

  return { success: false, error: `Login timed out after ${opts.expiresIn}s`, errorCode: "timeout" };
}

/**
 * Open a URL in the system browser.
 * Returns true if spawn succeeded.
 */
export function openBrowser(url: string): boolean {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}
