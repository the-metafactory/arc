import { join } from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import type {
  ArcManifest,
  RegistrySource,
  UploadResult,
  RegisterResult,
  EnsurePackageResult,
} from "../types.js";
import { README_VARIANTS } from "./bundle.js";

// ── Constants ────────────────────────────────────────────────

const API_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;

// ── Debug logging ────────────────────────────────────────────

function debugLog(msg: string): void {
  if (process.env.ARC_DEBUG === "1") {
    process.stderr.write(`[arc:publish] ${msg}\n`);
  }
}

// ── HTTP helpers ─────────────────────────────────────────────

function buildPublishHeaders(source: RegistrySource): Record<string, string> {
  return { Authorization: `Bearer ${source.token}` };
}

// ── README extraction ────────────────────────────────────────

/** Extract raw README markdown from a package directory */
export async function extractReadme(packageDir: string): Promise<string | null> {
  for (const variant of README_VARIANTS) {
    const readmePath = join(packageDir, variant);
    if (existsSync(readmePath)) {
      return readFile(readmePath, "utf-8");
    }
  }
  return null;
}

// ── Scope resolution ─────────────────────────────────────────

/** Resolve the publish scope (namespace) with three-tier priority */
export async function resolvePublishScope(
  manifest: ArcManifest,
  source: RegistrySource,
  cliScope?: string,
): Promise<string | null> {
  // 1. CLI --scope flag
  if (cliScope) return cliScope;

  // 2. Manifest namespace field
  if (manifest.namespace) return manifest.namespace;

  // 3. Fetch from /auth/me API
  if (!source.token) return null;

  try {
    const resp = await fetch(`${source.url}/api/v1/auth/me`, {
      headers: buildPublishHeaders(source),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const body = (await resp.json()) as { namespace?: string };
    return body.namespace ?? null;
  } catch (err) {
    debugLog(`/auth/me scope resolution failed: ${(err as Error).message}`);
    return null;
  }
}

// ── Upload ───────────────────────────────────────────────────

/** Upload a tarball to the registry storage endpoint */
export async function uploadBundle(
  tarballPath: string,
  source: RegistrySource,
  clientSha256: string,
): Promise<UploadResult> {
  const file = Bun.file(tarballPath);
  const buffer = await file.arrayBuffer();

  try {
    const resp = await fetch(`${source.url}/api/v1/storage/upload`, {
      method: "POST",
      headers: {
        ...buildPublishHeaders(source),
        "Content-Type": "application/octet-stream",
      },
      body: buffer,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (resp.status === 401) {
      return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: 'Not authenticated. Run "arc login" first.' };
    }

    if (resp.status === 413) {
      return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: "Package too large for server." };
    }

    const body = (await resp.json()) as { sha256?: string; r2_key?: string; size_bytes?: number; error?: string };

    // 409 = content already exists — treat as success (idempotent)
    if (resp.status === 409) {
      if (!body.sha256 || !body.r2_key) {
        return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: "Server returned 409 with missing sha256/r2_key fields." };
      }
      return { success: true, sha256: body.sha256, r2Key: body.r2_key, sizeBytes: body.size_bytes ?? 0 };
    }

    if (!resp.ok) {
      return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: body.error ?? `Upload failed: HTTP ${resp.status}` };
    }

    if (!body.sha256 || !body.r2_key) {
      return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: "Server response missing sha256 or r2_key fields." };
    }

    // Verify SHA-256 match
    if (body.sha256 !== clientSha256) {
      return { success: false, sha256: body.sha256, r2Key: body.r2_key, sizeBytes: body.size_bytes ?? 0, error: `SHA-256 mismatch: client=${clientSha256}, server=${body.sha256}` };
    }

    return { success: true, sha256: body.sha256, r2Key: body.r2_key, sizeBytes: body.size_bytes ?? 0 };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: "Upload timed out (120s limit)." };
    }
    return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: `Upload failed: ${(err as Error).message}` };
  }
}

// ── Package existence check ──────────────────────────────────

/** Check if package exists; auto-create on first publish */
export async function ensurePackageExists(
  source: RegistrySource,
  scope: string,
  name: string,
  manifest: ArcManifest,
): Promise<EnsurePackageResult> {
  const headers = buildPublishHeaders(source);

  try {
    const getResp = await fetch(
      `${source.url}/api/v1/packages/${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(name)}`,
      { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );

    if (getResp.status === 200) {
      return { exists: true, created: false };
    }

    if (getResp.status !== 404) {
      const body = await getResp.json().catch(() => ({})) as { error?: string };
      if (getResp.status === 403) {
        return { exists: false, created: false, error: `You do not own namespace @${scope}. Complete identity verification at meta-factory.ai.` };
      }
      return { exists: false, created: false, error: body.error ?? `Unexpected status: ${getResp.status}` };
    }

    const createResp = await fetch(`${source.url}/api/v1/packages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: scope, name, type: manifest.type, description: manifest.description ?? "" }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (createResp.status === 201 || createResp.status === 200) {
      return { exists: true, created: true };
    }

    const createBody = await createResp.json().catch(() => ({})) as { error?: string };
    if (createResp.status === 403) {
      return { exists: false, created: false, error: `You do not own namespace @${scope}. Complete identity verification at meta-factory.ai.` };
    }

    return { exists: false, created: false, error: createBody.error ?? `Failed to create package: HTTP ${createResp.status}` };
  } catch (err) {
    return { exists: false, created: false, error: `Network error checking package existence: ${(err as Error).message}` };
  }
}

// ── Version registration ─────────────────────────────────────

export interface RegisterPayload {
  version: string;
  sha256: string;
  r2_key: string;
  size_bytes: number;
  manifest: ArcManifest;
  readme?: string;
}

/** Register a new version for an existing package */
export async function registerVersion(
  source: RegistrySource,
  scope: string,
  name: string,
  payload: RegisterPayload,
): Promise<RegisterResult> {
  const url = `${source.url}/api/v1/packages/${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(name)}/versions`;
  const headers = { ...buildPublishHeaders(source), "Content-Type": "application/json" };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (resp.status === 201 || resp.status === 200) {
        const body = (await resp.json()) as { version_id?: string };
        return { success: true, versionId: body.version_id, statusCode: resp.status };
      }

      const body = (await resp.json().catch(() => ({}))) as { error?: string };

      if (resp.status === 409) {
        return { success: false, error: `Version ${payload.version} already exists. Published versions are immutable — bump the version in arc-manifest.yaml.`, statusCode: 409 };
      }

      if (resp.status === 400) {
        return { success: false, error: body.error ?? "Manifest validation failed on server.", statusCode: 400 };
      }

      if (resp.status === 403) {
        return { success: false, error: `Namespace @${scope} not owned. Complete identity verification at meta-factory.ai.`, statusCode: 403 };
      }

      if (resp.status === 401) {
        return { success: false, error: 'Not authenticated. Run "arc login" first.', statusCode: 401 };
      }

      if (resp.status >= 500 && attempt === 0) continue;

      return { success: false, error: body.error ?? `Registration failed: HTTP ${resp.status}`, statusCode: resp.status };
    } catch (err) {
      if (attempt === 0) continue;
      return { success: false, error: `Network error during version registration: ${(err as Error).message}` };
    }
  }

  return { success: false, error: "Registration failed after retries." };
}
