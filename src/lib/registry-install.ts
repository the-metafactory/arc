import { join } from "path";
import { existsSync } from "fs";
import { writeFile, unlink, mkdir } from "fs/promises";
import type {
  PackageRef,
  VerifyResult,
  RegistrySource,
} from "../types.js";
import { getSourceType } from "./sources.js";
import { fetchMetafactoryPackageDetail } from "./metafactory-api.js";

// ---------------------------------------------------------------------------
// Package reference parsing
// ---------------------------------------------------------------------------

const PACKAGE_REF_RE = /^@?([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)(?:@([^@]+))?$/;

/** Parse @scope/name[@version] from CLI input. Returns null for URLs/paths. */
export function parsePackageRef(input: string): PackageRef | null {
  // Skip URLs and local paths
  if (input.startsWith("http") || input.startsWith("git@") || input.startsWith("file://")) return null;
  if (input.startsWith("./") || input.startsWith("/") || input.startsWith("~")) return null;

  const match = input.match(PACKAGE_REF_RE);
  if (!match) return null;

  return {
    scope: match[1]!,
    name: match[2]!,
    version: match[3] || undefined,
  };
}

/** Format a PackageRef as @scope/name[@version] */
export function formatPackageRef(ref: PackageRef): string {
  const base = `@${ref.scope}/${ref.name}`;
  return ref.version ? `${base}@${ref.version}` : base;
}

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

export interface ResolvedRegistryPackage {
  scope: string;
  name: string;
  version: string;
  sha256: string;
  downloadUrl: string;
  source: RegistrySource;
  /** F-501 registry signature — null for legacy/unsigned versions. */
  registrySignature: string | null;
  /** F-501 key identifier — null for legacy/unsigned versions. */
  registryKeyId: string | null;
  /** Exact manifest bytes as signed — required for A-504 verification. */
  manifestCanonical: string | null;
  /** F-009 Sigstore bundle R2 key — null if not sigstore-signed. */
  signatureBundleKey: string | null;
  /** F-008 expected signer identity (GitHub Actions workflow URI). */
  signerIdentity: string | null;
  /** Publish timestamp from the signing block (informational). */
  signedAt: string | null;
}

/** Resolve a package from metafactory registry sources (anonymous — no auth required per DD-80) */
export async function resolveFromRegistry(
  ref: PackageRef,
  sources: RegistrySource[],
): Promise<ResolvedRegistryPackage | null> {
  const mfSources = sources.filter((s) => getSourceType(s) === "metafactory");
  if (!mfSources.length) return null;

  for (const source of mfSources) {
    const detail = await fetchMetafactoryPackageDetail(source, `@${ref.scope}`, ref.name);
    if (!detail) continue;

    // Resolve version
    const targetVersion = ref.version ?? detail.latest_version;
    if (!targetVersion) continue;

    // Fetch per-version detail: returns sha256, signing (F-501), and
    // manifest_canonical (exact bytes as signed, required for A-504).
    const versionDetailUrl = `${source.url}/api/v1/packages/${encodeURIComponent(`@${ref.scope}`)}/${encodeURIComponent(ref.name)}@${encodeURIComponent(targetVersion)}`;
    try {
      const resp = await fetch(versionDetailUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) continue;

      const body = (await resp.json()) as {
        version: string;
        sha256: string;
        manifest_canonical?: string;
        signing?: {
          registry_signature: string | null;
          registry_key_id: string | null;
          signature_bundle_key?: string | null;
          signer_identity?: string | null;
          signed_at?: string | null;
        };
      };

      if (!body.sha256) continue;

      const downloadUrl = `${source.url}/api/v1/storage/download/${body.sha256}`;

      return {
        scope: ref.scope,
        name: ref.name,
        version: targetVersion,
        sha256: body.sha256,
        downloadUrl,
        source,
        registrySignature: body.signing?.registry_signature ?? null,
        registryKeyId: body.signing?.registry_key_id ?? null,
        manifestCanonical: body.manifest_canonical ?? null,
        signatureBundleKey: body.signing?.signature_bundle_key ?? null,
        signerIdentity: body.signing?.signer_identity ?? null,
        signedAt: body.signing?.signed_at ?? null,
      };
    } catch (_err) {
      // Network error, try next source
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Closed enum of quarantine reason codes (arc#105 / mf#76).
 *
 * Mirrors `QUARANTINE_REASON_CODES` in meta-factory `src/lib/quarantine-reason-codes.ts`.
 * Adding a code is an intentional change on both sides — server emits, arc
 * branches install-time UX. Unknown codes from the wire collapse to
 * `QUARANTINED_OTHER` at the call site so a forward-compatible server roll
 * never crashes an older arc.
 */
export const QUARANTINE_REASON_CODES = [
  "QUARANTINED_SECURITY",
  "QUARANTINED_LEGAL",
  "QUARANTINED_POLICY",
  "QUARANTINED_OTHER",
] as const;

export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set(QUARANTINE_REASON_CODES);

export function isQuarantineReasonCode(value: unknown): value is QuarantineReasonCode {
  return typeof value === "string" && REASON_CODE_SET.has(value);
}

export interface QuarantineInfo {
  reasonCode: QuarantineReasonCode;
  /** Steward-supplied free-text reason; may be empty if server omitted it. */
  reason: string;
}

/**
 * Exit code for an `arc install` blocked by marketplace quarantine.
 *
 * Distinct from the generic failure code (1) so scripts can branch on
 * "package was deliberately removed" vs "transient / not-found / network".
 * Documented in the user-facing CLI reference.
 */
export const QUARANTINE_EXIT_CODE = 4;

/**
 * ANSI helpers. We keep them inline (no chalk dep) and fall back to plain
 * text when stderr is not a TTY — pipelines, CI logs, and `arc … 2>&1` all
 * stay free of escape sequences. The `colorEnabled` arg is injectable so
 * tests can assert both code paths without spoofing process.stderr.
 */
const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_RED_BG = "\x1b[41;97m";
const ANSI_YELLOW_BG = "\x1b[43;30m";
const ANSI_GREY_BG = "\x1b[100;97m";

function banner(label: string, palette: string, colorEnabled: boolean): string {
  if (!colorEnabled) return `[${label}]`;
  return `${palette}${ANSI_BOLD} ${label} ${ANSI_RESET}`;
}

/**
 * Build the CLI output block for a 451 quarantine response.
 *
 * Pure function: no console writes, no exit. Callers print the returned
 * `lines` to stderr and exit with `QUARANTINE_EXIT_CODE`. Each reason code
 * gets distinct framing so a user (or a wrapping script) can tell at a
 * glance whether they hit a security removal, a legal takedown, or a
 * policy violation, without parsing the steward's free-text `reason`.
 */
export function formatQuarantineMessage(
  pkgLabel: string,
  info: QuarantineInfo,
  colorEnabled: boolean,
): string[] {
  const lines: string[] = [];
  switch (info.reasonCode) {
    case "QUARANTINED_SECURITY":
      lines.push(`${banner("SECURITY QUARANTINE", ANSI_RED_BG, colorEnabled)} ${pkgLabel}`);
      lines.push("This package was removed by the marketplace because of a security concern (malware, exfiltration, supply-chain compromise, or similar).");
      lines.push("Do not attempt to bypass this block. If you have a previously installed copy locally, treat it as suspect.");
      break;
    case "QUARANTINED_POLICY":
      lines.push(`${banner("POLICY QUARANTINE", ANSI_YELLOW_BG, colorEnabled)} ${pkgLabel}`);
      lines.push("This package was removed for a policy violation (terms of service, capability drift, naming squat, or similar).");
      break;
    case "QUARANTINED_LEGAL":
      lines.push(`${banner("LEGAL QUARANTINE", ANSI_GREY_BG, colorEnabled)} ${pkgLabel}`);
      lines.push("This package is unavailable for legal reasons (DMCA, court order, sanctions, or similar).");
      break;
    case "QUARANTINED_OTHER":
    default:
      lines.push(`${banner("QUARANTINED", ANSI_GREY_BG, colorEnabled)} ${pkgLabel}`);
      lines.push("This package has been quarantined by the marketplace.");
      break;
  }
  if (info.reason && info.reason.trim().length > 0) {
    lines.push("");
    lines.push(`Reason: ${info.reason.trim()}`);
  }
  lines.push("");
  lines.push(`Reason code: ${info.reasonCode}`);
  return lines;
}

export interface DownloadResult {
  success: boolean;
  tempPath?: string;
  bytesDownloaded?: number;
  error?: string;
  /**
   * Present iff the storage endpoint returned HTTP 451 (Unavailable for Legal
   * Reasons) per the marketplace quarantine contract (mf#76 / arc#105).
   * `success` is false; CLI should render code-specific UX and exit with a
   * distinct non-zero code (4) so scripts can distinguish quarantine from
   * a missing artifact (404 → 1).
   */
  quarantine?: QuarantineInfo;
}

/** Maximum number of HTTP redirects to follow on a single download. */
const MAX_REDIRECTS = 5;

/**
 * Fetch with explicit cross-origin Authorization stripping.
 *
 * If an auth'd request is redirected to a different origin (e.g. storage
 * 302s to a presigned R2/S3 URL), drop the Authorization header on the
 * next hop so the bearer token never reaches the redirect target. The
 * WHATWG `fetch` spec already mandates this, but pinning the contract
 * here protects against runtime changes and makes the intent observable
 * in tests. Same-origin redirects keep the header.
 *
 * After MAX_REDIRECTS hops without reaching a non-3xx response, throw —
 * never fall back to default fetch redirect-following, which would void
 * the no-leak contract this function exists to enforce.
 */
async function fetchFollowingRedirects(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<Response> {
  let currentUrl = url;
  let currentHeaders = { ...init.headers };
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, {
      headers: currentHeaders,
      signal: init.signal,
      redirect: "manual",
    });
    const status = response.status;
    if (status < 300 || status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
    currentUrl = nextUrl;
    if (!sameOrigin && currentHeaders.Authorization) {
      const { Authorization: _drop, ...rest } = currentHeaders;
      currentHeaders = rest;
    }
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) following ${url}`);
}

/**
 * Download a package tarball from the storage endpoint.
 *
 * When `source` is provided and is a metafactory source with a stored bearer
 * token, attaches `Authorization: Bearer <token>` so the request can pass
 * through an auth-gated storage endpoint (issue #83). For sources without a
 * token, or registry-type sources, the request stays anonymous (DD-80) so
 * public unauthenticated installs continue to work.
 *
 * Redirects are followed manually: on a cross-origin redirect (e.g. 302 to
 * a presigned R2/S3 URL), the Authorization header is stripped before the
 * next hop so the bearer never leaks to a third-party storage origin.
 */
export async function downloadPackage(
  url: string,
  tempDir: string,
  source?: RegistrySource,
): Promise<DownloadResult> {
  const tempPath = join(tempDir, `arc-download-${Date.now()}.tar.gz`);

  const headers: Record<string, string> = {};
  if (source && source.token && getSourceType(source) === "metafactory") {
    headers.Authorization = `Bearer ${source.token}`;
  }

  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchFollowingRedirects(url, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: "Access denied by storage endpoint." };
      }
      if (response.status === 404) {
        return { success: false, error: "Package artifact not found at storage endpoint." };
      }
      if (response.status === 451) {
        // Marketplace has quarantined this package (mf#76 / arc#105). Read the
        // header first because it's the authoritative wire signal; fall back
        // to the JSON body's `reason_code` if a misconfigured upstream omits
        // the header. Body parse failures must never throw — the user gets a
        // generic "QUARANTINED_OTHER" rather than a stack trace.
        const headerCode = response.headers.get("X-Quarantine-Reason-Code");
        let bodyReasonCode: string | null = null;
        let bodyReason = "";
        try {
          const body = (await response.json()) as {
            reason_code?: unknown;
            reason?: unknown;
          };
          bodyReasonCode = typeof body.reason_code === "string" ? body.reason_code : null;
          bodyReason = typeof body.reason === "string" ? body.reason : "";
        } catch {
          // Non-JSON or empty body: header alone carries the code.
        }
        const candidate = headerCode ?? bodyReasonCode;
        const reasonCode: QuarantineReasonCode = isQuarantineReasonCode(candidate)
          ? candidate
          : "QUARANTINED_OTHER";
        return {
          success: false,
          error: `Package quarantined by marketplace (${reasonCode}).`,
          quarantine: { reasonCode, reason: bodyReason },
        };
      }
      if (!response.ok) {
        lastError = `Download failed: HTTP ${response.status}`;
        continue;
      }

      const buffer = await response.arrayBuffer();
      await writeFile(tempPath, Buffer.from(buffer));

      return {
        success: true,
        tempPath,
        bytesDownloaded: buffer.byteLength,
      };
    } catch (_err) {
      lastError = "Download failed: network error. Check your connection and try again.";
    }
  }

  return { success: false, error: lastError };
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

/** Verify SHA-256 checksum of a downloaded file */
export async function verifyChecksum(
  filePath: string,
  expectedSha256: string,
): Promise<VerifyResult> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  const actual = hasher.digest("hex");

  return {
    valid: actual === expectedSha256.toLowerCase(),
    expected: expectedSha256.toLowerCase(),
    actual,
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractResult {
  success: boolean;
  extractedPath: string;
  error?: string;
}

/** Extract a tarball to the repos directory */
export async function extractPackage(
  tarballPath: string,
  reposDir: string,
  packageName: string,
): Promise<ExtractResult> {
  const extractedPath = join(reposDir, packageName);

  if (!existsSync(reposDir)) {
    await mkdir(reposDir, { recursive: true });
  }

  // Create target directory
  await mkdir(extractedPath, { recursive: true });

  const result = Bun.spawnSync(
    ["tar", "xzf", tarballPath, "-C", extractedPath, "--strip-components=1"],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    // Clean up partial extraction
    Bun.spawnSync(["rm", "-rf", extractedPath], { stdout: "pipe", stderr: "pipe" });
    return {
      success: false,
      extractedPath,
      error: `Extraction failed: ${result.stderr.toString().trim()}`,
    };
  }

  // Clean up tarball -- cleanup failure is non-fatal
  await unlink(tarballPath).catch((_err) => {});

  // Verify manifest exists
  const hasManifest = existsSync(join(extractedPath, "arc-manifest.yaml")) ||
    existsSync(join(extractedPath, "pai-manifest.yaml"));

  if (!hasManifest) {
    Bun.spawnSync(["rm", "-rf", extractedPath], { stdout: "pipe", stderr: "pipe" });
    return {
      success: false,
      extractedPath,
      error: "Package archive does not contain arc-manifest.yaml. Invalid package format.",
    };
  }

  return { success: true, extractedPath };
}
