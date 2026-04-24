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

/** Coerce a server error field (string | object | unknown) into a readable message. */
function formatServerError(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as { message?: unknown; error?: unknown };
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

// ── HTTP helpers ─────────────────────────────────────────────

function buildPublishHeaders(source: RegistrySource): Record<string, string> {
  return { Authorization: `Bearer ${source.token}` };
}

/**
 * Prefer the informative top-level `message` field over the generic `error`
 * field. Falls back to `formatServerError` so nested/object `error` payloads
 * from older servers still render readable messages instead of "[object Object]".
 */
export function combineError(body: { error?: unknown; message?: unknown } | null | undefined): string | undefined {
  if (!body) return undefined;
  if (typeof body.message === "string" && body.message.length > 0) return body.message;
  return formatServerError(body.error);
}

// ── Manifest transformation ───────────────────────────────────

/**
 * Convert an arc-format manifest (arc/v1) to the server-expected
 * metafactory/v1 format before sending to the registry API.
 */
export function toServerManifest(manifest: ArcManifest, scope: string): Record<string, unknown> {
  const caps = manifest.capabilities ?? {};

  // Filesystem: arc uses { read: [path], write: [path] }, server uses [{ path, access }]
  const filesystem: Array<{ path: string; access: string }> = [];
  for (const p of (caps.filesystem?.read ?? [])) {
    filesystem.push({ path: p, access: "read" });
  }
  for (const p of (caps.filesystem?.write ?? [])) {
    filesystem.push({ path: p, access: "write" });
  }

  // Network: arc uses [{ domain, reason }] (string shorthand "example.com" is
  // normalised at readManifest, but coerce defensively here in case a manifest
  // was constructed in-memory without going through readManifest — issue #79).
  // Server schema requires { domain }.
  const network = (caps.network ?? []).flatMap((n): Array<{ domain: string }> => {
    if (typeof n === "string") return [{ domain: n }];
    if (n && typeof (n as any).domain === "string") return [{ domain: (n as any).domain }];
    return [];
  });

  // Bash → subprocess
  const subprocess: Array<{ command: string }> = [];
  if (caps.bash?.allowed) {
    for (const cmd of (caps.bash.restricted_to ?? [])) {
      subprocess.push({ command: cmd });
    }
    if (!caps.bash.restricted_to?.length) {
      subprocess.push({ command: "*" });
    }
  }

  // Secrets → environment
  const environment = (caps.secrets ?? []).map((v) => ({ variable: v }));

  const serverCaps: Record<string, unknown> = {};
  if (filesystem.length) serverCaps.filesystem = filesystem;
  if (network.length) serverCaps.network = network;
  if (subprocess.length) serverCaps.subprocess = subprocess;
  if (environment.length) serverCaps.environment = environment;

  return {
    schema: "metafactory/v1",
    name: `@${scope}/${manifest.name}`,
    version: manifest.version,
    type: manifest.type,
    author: { name: manifest.author?.name ?? scope },
    license: manifest.license ?? "MIT",
    ...(manifest.description ? { description: manifest.description } : {}),
    capabilities: serverCaps,
  };
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

    const body = (await resp.json()) as { sha256?: string; r2_key?: string; size_bytes?: number; error?: unknown; message?: unknown };

    // 409 = content already exists — treat as success (idempotent)
    // Server may not return sha256/r2_key on 409, so fall back to client-known values.
    if (resp.status === 409) {
      return {
        success: true,
        sha256: body.sha256 ?? clientSha256,
        r2Key: body.r2_key ?? `packages/${clientSha256}.tar.gz`,
        sizeBytes: body.size_bytes ?? buffer.byteLength,
      };
    }

    if (!resp.ok) {
      return { success: false, sha256: "", r2Key: "", sizeBytes: 0, error: combineError(body) ?? `Upload failed: HTTP ${resp.status}` };
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
      const body = await getResp.json().catch(() => ({})) as { error?: unknown; message?: unknown };
      if (getResp.status === 403) {
        return { exists: false, created: false, error: `You do not own namespace @${scope}. Complete identity verification at meta-factory.ai.` };
      }
      return { exists: false, created: false, error: combineError(body) ?? `Unexpected status: ${getResp.status}` };
    }

    const createResp = await fetch(`${source.url}/api/v1/packages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: scope, name, type: manifest.type, description: manifest.description ?? "", license: manifest.license ?? "MIT" }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (createResp.status === 201 || createResp.status === 200) {
      return { exists: true, created: true };
    }

    const createBody = await createResp.json().catch(() => ({})) as { error?: unknown; message?: unknown };
    if (createResp.status === 403) {
      return { exists: false, created: false, error: `You do not own namespace @${scope}. Complete identity verification at meta-factory.ai.` };
    }

    return { exists: false, created: false, error: combineError(createBody) ?? `Failed to create package: HTTP ${createResp.status}` };
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
  scope: string;
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

  const serverPayload = {
    version: payload.version,
    sha256: payload.sha256,
    r2_key: payload.r2_key,
    size_bytes: payload.size_bytes,
    manifest: toServerManifest(payload.manifest, payload.scope),
    readme: payload.readme,
  };
  debugLog(`registerVersion payload: ${JSON.stringify(serverPayload)}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(serverPayload),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (resp.status === 201 || resp.status === 200) {
        const body = (await resp.json()) as { version_id?: string };
        return { success: true, versionId: body.version_id, statusCode: resp.status };
      }

      const body = (await resp.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
      const serverError = combineError(body);

      if (resp.status === 409) {
        return { success: false, error: `Version ${payload.version} already exists. Published versions are immutable — bump the version in arc-manifest.yaml.`, statusCode: 409 };
      }

      if (resp.status === 400) {
        return { success: false, error: serverError ?? "Manifest validation failed on server.", statusCode: 400 };
      }

      if (resp.status === 403) {
        return { success: false, error: `Namespace @${scope} not owned. Complete identity verification at meta-factory.ai.`, statusCode: 403 };
      }

      if (resp.status === 401) {
        return { success: false, error: 'Not authenticated. Run "arc login" first.', statusCode: 401 };
      }

      if (resp.status >= 500 && attempt === 0) continue;

      return { success: false, error: serverError ?? `Registration failed: HTTP ${resp.status}`, statusCode: resp.status };
    } catch (err) {
      if (attempt === 0) continue;
      return { success: false, error: `Network error during version registration: ${(err as Error).message}` };
    }
  }

  return { success: false, error: "Registration failed after retries." };
}
