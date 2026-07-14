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

// arc#204: POST /versions runs L1+L2 validation IN-BAND on the registry
// (meta-factory#300) — ~9s for an 8 MB package, more under load. The shared
// 10s API timeout sat right on that edge: aborting mid-request disconnects
// the client, Cloudflare cancels the request context, and the submission is
// stranded at `validating` (then system-rejected by the reconciler). Give
// registration its own budget well clear of the in-band validation time.
const REGISTER_TIMEOUT_MS = 60_000;

/** Submission statuses that end the publish-side wait (human review is next, or it's decided). */
const TERMINAL_SUBMISSION_STATUSES = new Set(["pending_review", "approved", "rejected"]);

const SUBMISSION_POLL_INTERVAL_MS = 5_000;
const SUBMISSION_POLL_TIMEOUT_MS = 90_000;

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
    try { return JSON.stringify(err); } catch {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      return String(err);
    }
  }
  // After narrowing above, err is a primitive — String() is safe.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(err);
}

// ── HTTP helpers ─────────────────────────────────────────────

function buildPublishHeaders(source: RegistrySource): Record<string, string> {
  return { Authorization: `Bearer ${source.token}` };
}

/**
 * The identity/verification host to point a user at on a namespace-ownership
 * error — derived from the CONFIGURED source so a self-hosted or non-metafactory
 * registry names its OWN host, not a hardcoded `meta-factory.ai` (arc#302).
 * arc supports non-metafactory sources (`--type registry`); an error that always
 * said "verify at meta-factory.ai" sent those users to the wrong place.
 */
function identityHost(source: RegistrySource): string {
  try {
    return new URL(source.url).host;
  } catch {
    // Malformed url (shouldn't happen — validated at `source add`) → show the
    // raw configured value rather than a wrong hardcoded host.
    return source.url;
  }
}

interface SubmissionWire {
  id?: string;
  status?: string;
  review_comment?: string | null;
}

type SubmissionBody = {
  submission_id?: string;
  submission_status?: string;
  review_comment?: string | null;
  submission?: SubmissionWire;
  // The existing-submission probe returns flat { id, status } instead of
  // wrapping the payload under `submission`, so accept both wire shapes.
} & SubmissionWire;

const VISIBLE_SUBMISSION_STATUSES = new Set([
  "submitted",
  "validating",
  "audit",
  "pending_review",
  "rejected",
]);

function normalizeSubmission(body: SubmissionBody): RegisterResult["submission"] | undefined {
  const nested = body.submission;
  const status = nested?.status ?? body.submission_status ?? body.status;
  if (!status || !VISIBLE_SUBMISSION_STATUSES.has(status)) return undefined;

  return {
    id: nested?.id ?? body.submission_id ?? body.id,
    status,
    reviewComment: nested?.review_comment ?? body.review_comment ?? null,
  };
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
  const filesystem: { path: string; access: string }[] = [];
  for (const p of (caps.filesystem?.read ?? [])) {
    filesystem.push({ path: p, access: "read" });
  }
  for (const p of (caps.filesystem?.write ?? [])) {
    filesystem.push({ path: p, access: "write" });
  }

  // Network: arc uses [{ domain, reason }] (string shorthand "example.com" is
  // normalised at readManifest, but coerce defensively here in case a manifest
  // was constructed in-memory without going through readManifest — issue #79).
  // Server schema requires { domain }. The type asserts every entry is an
  // object, but legacy YAML may have plain strings — cast through unknown.
  const networkEntries = (caps.network ?? []) as unknown[];
  const network = networkEntries.flatMap((n): { domain: string }[] => {
    if (typeof n === "string") return [{ domain: n }];
    if (n && typeof n === "object") {
      const obj = n as { domain?: unknown };
      if (typeof obj.domain === "string") return [{ domain: obj.domain }];
    }
    return [];
  });

  // Bash → subprocess
  const subprocess: { command: string }[] = [];
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

  // Optional discovery / provenance metadata forwarded as-is to the registry
  // when the publisher set it in arc-manifest.yaml. Server-side validation
  // (MetafactoryManifest in meta-factory/src/types/manifest.ts) enforces the
  // accepted shapes; arc stays a thin pass-through so the source of truth
  // remains on one side. The `repository` field opens the same-repo image
  // rewrite for README rendering (the-metafactory/meta-factory#501 / #502 /
  // #505) — without it, relative `<img src="docs/...">` paths in the
  // published README cannot be resolved against the repo's raw content and
  // surface as broken-image icons on the package landing page.
  return {
    schema: "metafactory/v1",
    name: `@${scope}/${manifest.name}`,
    version: manifest.version,
    type: manifest.type,
    author: { name: manifest.author?.name ?? scope },
    license: manifest.license ?? "MIT",
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.repository ? { repository: manifest.repository } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    ...(manifest.keywords && manifest.keywords.length > 0
      ? { keywords: manifest.keywords }
      : {}),
    ...(manifest.category ? { category: manifest.category } : {}),
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
        return { exists: false, created: false, error: `You do not own namespace @${scope}. Complete identity verification at ${identityHost(source)}.` };
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
      return { exists: false, created: false, error: `You do not own namespace @${scope}. Complete identity verification at ${identityHost(source)}.` };
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
  signature_bundle_key?: string;
  signer_identity?: string;
  signed_at?: number;
}

export interface UploadSigstoreBundleResult {
  success: boolean;
  bundleKey?: string;
  sizeBytes?: number;
  error?: string;
}

/** Upload a cosign signature bundle for an already-uploaded tarball hash. */
export async function uploadSigstoreBundle(
  bundlePath: string,
  source: RegistrySource,
  sha256: string,
): Promise<UploadSigstoreBundleResult> {
  const file = Bun.file(bundlePath);
  const bundleJson = await file.text();
  const expectedBundleKey = `packages/${sha256}.bundle`;

  try {
    const resp = await fetch(`${source.url}/api/v1/storage/bundle/${sha256}`, {
      method: "PUT",
      headers: {
        ...buildPublishHeaders(source),
        "Content-Type": "application/json",
      },
      body: bundleJson,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (resp.status === 401) {
      return { success: false, error: 'Not authenticated. Run "arc login" first.' };
    }

    const body = (await resp.json().catch(() => ({}))) as { bundle_key?: string; size_bytes?: number; error?: unknown; message?: unknown };

    if (resp.status === 409) {
      return { success: true, bundleKey: body.bundle_key ?? expectedBundleKey, sizeBytes: body.size_bytes ?? Buffer.byteLength(bundleJson) };
    }

    if (!resp.ok) {
      return { success: false, error: combineError(body) ?? `Sigstore bundle upload failed: HTTP ${resp.status}` };
    }

    if (!body.bundle_key) {
      return { success: false, error: "Server response missing bundle_key field." };
    }

    if (body.bundle_key !== expectedBundleKey) {
      return { success: false, error: `Sigstore bundle key mismatch: expected=${expectedBundleKey}, server=${body.bundle_key}` };
    }

    return { success: true, bundleKey: body.bundle_key, sizeBytes: body.size_bytes ?? Buffer.byteLength(bundleJson) };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { success: false, error: "Sigstore bundle upload timed out (120s limit)." };
    }
    return { success: false, error: `Sigstore bundle upload failed: ${(err as Error).message}` };
  }
}

/** Register a new version for an existing package */
export interface RegisterVersionOpts {
  /** Poll cadence for the post-timeout submission probe (tests inject ~1ms). */
  pollIntervalMs?: number;
  /** Overall budget for polling the submission to a terminal status. */
  pollTimeoutMs?: number;
}

/**
 * Poll the per-version submission endpoint until the submission reaches a
 * terminal status or the budget runs out (arc#204). Returns the last
 * submission seen (terminal or not), or undefined when none is visible.
 */
async function pollSubmissionToTerminal(
  submissionUrl: string,
  headers: Record<string, string>,
  opts?: RegisterVersionOpts,
): Promise<{ submission: NonNullable<RegisterResult["submission"]>; terminal: boolean } | undefined> {
  const intervalMs = opts?.pollIntervalMs ?? SUBMISSION_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts?.pollTimeoutMs ?? SUBMISSION_POLL_TIMEOUT_MS);
  let last: RegisterResult["submission"] | undefined;

  for (;;) {
    const submission = await fetch(submissionUrl, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
      .then(async (resp) => {
        if (!resp.ok) return undefined;
        const body = (await resp.json().catch(() => ({}))) as SubmissionBody;
        return normalizeSubmission(body);
      })
      .catch(() => undefined);

    if (submission) {
      last = submission;
      if (submission.status && TERMINAL_SUBMISSION_STATUSES.has(submission.status)) {
        return { submission, terminal: true };
      }
    }
    if (Date.now() >= deadline) {
      return last ? { submission: last, terminal: false } : undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function registerVersion(
  source: RegistrySource,
  scope: string,
  name: string,
  payload: RegisterPayload,
  opts?: RegisterVersionOpts,
): Promise<RegisterResult> {
  const url = `${source.url}/api/v1/packages/${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(name)}/versions`;
  const submissionUrl = `${url}/${encodeURIComponent(payload.version)}/submission`;
  const headers = { ...buildPublishHeaders(source), "Content-Type": "application/json" };

  const serverPayload = {
    version: payload.version,
    sha256: payload.sha256,
    r2_key: payload.r2_key,
    size_bytes: payload.size_bytes,
    manifest: toServerManifest(payload.manifest, payload.scope),
    readme: payload.readme,
    ...(payload.signature_bundle_key !== undefined ? { signature_bundle_key: payload.signature_bundle_key } : {}),
    ...(payload.signer_identity !== undefined ? { signer_identity: payload.signer_identity } : {}),
    ...(payload.signed_at !== undefined ? { signed_at: payload.signed_at } : {}),
  };
  debugLog(`registerVersion payload: ${JSON.stringify(serverPayload)}`);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(serverPayload),
      // arc#204: dedicated budget — this endpoint validates in-band.
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });

    if (resp.status === 201 || resp.status === 200) {
      const body = (await resp.json()) as {
        version_id?: string;
        version?: { id?: string };
      } & SubmissionBody;
      const submission = normalizeSubmission(body);
      return {
        success: true,
        versionId: body.version_id ?? body.version?.id,
        submissionId: body.submission_id ?? body.submission?.id,
        submission,
        statusCode: resp.status,
      };
    }

    const body = (await resp.json().catch(() => ({}))) as { error?: unknown; message?: unknown } & SubmissionBody;
    const serverError = combineError(body);
    const inlineSubmission = normalizeSubmission(body);

    if (inlineSubmission) {
      return {
        success: true,
        submissionId: inlineSubmission.id,
        submission: inlineSubmission,
        statusCode: resp.status,
      };
    }

    if (resp.status === 409) {
      const existingSubmission = await fetch(submissionUrl, {
        headers: buildPublishHeaders(source),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
        .then(async (submissionResp) => {
          if (!submissionResp.ok) return undefined;
          const submissionBody = (await submissionResp.json().catch(() => ({}))) as SubmissionBody;
          return normalizeSubmission(submissionBody);
        })
        .catch(() => undefined);

      if (existingSubmission) {
        return {
          success: true,
          submissionId: existingSubmission.id,
          submission: existingSubmission,
          statusCode: 409,
        };
      }

      return { success: false, error: `Version ${payload.version} already exists. Published versions are immutable — bump the version in arc-manifest.yaml.`, statusCode: 409 };
    }

    if (resp.status === 400) {
      return { success: false, error: serverError ?? "Manifest validation failed on server.", statusCode: 400 };
    }

    if (resp.status === 403) {
      return { success: false, error: `Namespace @${scope} not owned. Complete identity verification at ${identityHost(source)}.`, statusCode: 403 };
    }

    if (resp.status === 401) {
      return { success: false, error: 'Not authenticated. Run "arc login" first.', statusCode: 401 };
    }

    return { success: false, error: serverError ?? `Registration failed: HTTP ${resp.status}`, statusCode: resp.status };
  } catch (err) {
    const e = err as Error;

    // arc#204: an aborted/timed-out POST is NOT a plain network error —
    // the server may have created the submission and may even finish
    // validating it (or the disconnect may have stranded it; see
    // meta-factory#520). Poll the per-version submission endpoint to a
    // terminal status and report reality instead of guessing.
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      debugLog(`registration request aborted (${e.name}); polling submission status`);
      const polled = await pollSubmissionToTerminal(submissionUrl, buildPublishHeaders(source), opts);

      if (polled?.terminal) {
        return {
          success: true,
          submissionId: polled.submission.id,
          submission: polled.submission,
          statusCode: 200,
        };
      }

      if (polled) {
        return {
          success: false,
          error:
            `Registration request timed out and submission ${polled.submission.id ?? "<unknown>"} ` +
            `is still '${polled.submission.status}' after polling — the registry is processing it. ` +
            `Check ${submissionUrl} before retrying.`,
        };
      }

      return {
        success: false,
        error:
          "Registration request timed out and no submission is visible for this version — " +
          "the request likely never reached the registry. Retry the publish.",
      };
    }

    return { success: false, error: `Network error during version registration: ${e.message}` };
  }
}
