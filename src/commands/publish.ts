import { join, resolve } from "path";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { createBundle, computeChecksum } from "../lib/bundle.js";
import {
  extractReadme,
  resolvePublishScope,
  uploadBundle,
  uploadSigstoreBundle,
  ensurePackageExists,
  registerVersion,
} from "../lib/publish.js";
import { resolveSigningAuth, signSigstoreBundle, type SignSigstoreResult } from "../lib/cosign.js";
import { loadSources, findMetafactorySource } from "../lib/sources.js";
import { readManifest } from "../lib/manifest.js";
import type { ArcPaths } from "../types.js";

export interface PublishOptions {
  paths: ArcPaths;
  packageDir: string;
  tarballPath?: string;
  dryRun?: boolean;
  sourceName?: string;
  scope?: string;
  allowUnsignedOfficial?: boolean;
  signer?: (artifactPath: string, bundlePath: string) => Promise<SignSigstoreResult>;
}

export interface PublishCommandResult {
  success: boolean;
  name?: string;
  version?: string;
  scope?: string;
  sha256?: string;
  url?: string;
  submissionId?: string;
  submissionStatus?: string;
  reviewComment?: string | null;
  dryRun?: boolean;
  error?: string;
}

/** Execute the arc publish command */
export async function publish(opts: PublishOptions): Promise<PublishCommandResult> {
  const packageDir = resolve(opts.packageDir);

  // 1. Find metafactory source
  const sourcesConfig = await loadSources(opts.paths.sourcesPath);
  const sourceResult = findMetafactorySource(sourcesConfig, opts.sourceName);
  if ("error" in sourceResult) {
    return { success: false, error: sourceResult.error };
  }
  const source = sourceResult.source;

  // 2. Check authentication
  if (!source.token) {
    return { success: false, error: 'Not authenticated. Run "arc login" first.' };
  }

  // 3. Read manifest
  const manifest = await readManifest(packageDir);
  if (!manifest) {
    return { success: false, error: "No arc-manifest.yaml found in package directory." };
  }

  // 4. Resolve scope
  const scope = await resolvePublishScope(manifest, source, opts.scope);
  if (!scope) {
    return { success: false, error: "Could not determine publish scope. Use --scope <namespace> or add namespace to arc-manifest.yaml." };
  }

  // 5. Bundle (or use existing tarball)
  let tarballPath: string;
  let sha256: string;
  let tempTarball = false;

  if (opts.tarballPath) {
    tarballPath = resolve(opts.tarballPath);
    sha256 = await computeChecksum(tarballPath);
  } else {
    const bundleResult = await createBundle(packageDir);
    if (!bundleResult.success) {
      return { success: false, error: bundleResult.error };
    }
    tarballPath = bundleResult.tarballPath;
    sha256 = bundleResult.sha256;
    tempTarball = true;
  }

  // 6. Dry run — validate and display, then clean up
  if (opts.dryRun) {
    if (tempTarball) {
      await rm(tarballPath).catch(() => {
        // best-effort cleanup; tarball may already be gone
      });
    }
    return {
      success: true,
      name: manifest.name,
      version: manifest.version,
      scope,
      sha256,
      dryRun: true,
    };
  }

  let sigstoreBundlePath: string | undefined;

  try {
    if (source.tier === "official" && !opts.allowUnsignedOfficial && !opts.signer) {
      const signingAuth = resolveSigningAuth();
      if (signingAuth.kind === "unsupported") {
        return { success: false, error: `Sigstore signing failed: ${signingAuth.error}` };
      }
    }

    // 7. Upload tarball
    const uploadResult = await uploadBundle(tarballPath, source, sha256);
    if (!uploadResult.success) {
      return { success: false, error: uploadResult.error };
    }

    let signatureBundleKey: string | undefined;
    let signerIdentity: string | undefined;
    let signedAt: number | undefined;

    if (source.tier === "official" && !opts.allowUnsignedOfficial) {
      sigstoreBundlePath = join(tmpdir(), `arc-sigstore-${uploadResult.sha256}-${Date.now()}.bundle`);
      const signer = opts.signer ?? signSigstoreBundle;
      const signResult = await signer(tarballPath, sigstoreBundlePath);
      if (!signResult.success || !signResult.bundlePath) {
        return { success: false, error: `Sigstore signing failed: ${signResult.error ?? "bundle was not created"}` };
      }

      const bundleUpload = await uploadSigstoreBundle(signResult.bundlePath, source, uploadResult.sha256);
      if (!bundleUpload.success || !bundleUpload.bundleKey) {
        return { success: false, error: bundleUpload.error ?? "Sigstore bundle upload failed." };
      }

      signatureBundleKey = bundleUpload.bundleKey;
      signerIdentity = signResult.signerIdentity;
      signedAt = signResult.signedAt;
    }

    // 8. Ensure package exists
    const ensureResult = await ensurePackageExists(source, scope, manifest.name, manifest);
    if (!ensureResult.exists) {
      return { success: false, error: ensureResult.error ?? "Failed to create package." };
    }

    // 9. Extract README
    const readme = await extractReadme(packageDir);

    // 10. Register version
    const registerResult = await registerVersion(source, scope, manifest.name, {
      version: manifest.version,
      sha256: uploadResult.sha256,
      r2_key: uploadResult.r2Key,
      size_bytes: uploadResult.sizeBytes,
      manifest,
      scope,
      readme: readme ?? undefined,
      signature_bundle_key: signatureBundleKey,
      signer_identity: signerIdentity,
      signed_at: signedAt,
    });

    if (!registerResult.success) {
      return { success: false, error: registerResult.error };
    }

    if (registerResult.submission?.status === "rejected") {
      const reviewSuffix = registerResult.submission.reviewComment
        ? ` Review comment: ${registerResult.submission.reviewComment}`
        : "";
      return {
        success: false,
        name: manifest.name,
        version: manifest.version,
        scope,
        sha256: uploadResult.sha256,
        submissionId: registerResult.submissionId,
        submissionStatus: registerResult.submission.status,
        reviewComment: registerResult.submission.reviewComment,
        error: `Publish submission rejected${registerResult.submissionId ? ` (${registerResult.submissionId})` : ""}.${reviewSuffix}`,
      };
    }

    return {
      success: true,
      name: manifest.name,
      version: manifest.version,
      scope,
      sha256: uploadResult.sha256,
      url: `${source.url}/package/@${scope}/${manifest.name}`,
      submissionId: registerResult.submissionId,
      submissionStatus: registerResult.submission?.status,
      reviewComment: registerResult.submission?.reviewComment,
    };
  } finally {
    // Clean up temp tarball
    if (tempTarball) {
      await rm(tarballPath).catch(() => {
        // best-effort cleanup; tarball may already be gone
      });
    }
    if (sigstoreBundlePath) {
      await rm(sigstoreBundlePath).catch(() => {
        // best-effort cleanup; bundle may already be gone
      });
    }
  }
}

/** Format publish result for terminal output */
export function formatPublish(result: PublishCommandResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  if (result.dryRun) {
    return [
      `[DRY RUN] Would publish @${result.scope}/${result.name} v${result.version}`,
      `  SHA-256:  ${result.sha256}`,
      `  Source:   metafactory`,
    ].join("\n");
  }

  if (result.submissionStatus === "pending_review") {
    return [
      `Uploaded @${result.scope}/${result.name} v${result.version}; queued for review`,
      `  SHA-256:      ${result.sha256}`,
      ...(result.submissionId ? [`  Submission:   ${result.submissionId}`] : []),
      `  Status:       ${result.submissionStatus}`,
      `  URL:          ${result.url}`,
    ].join("\n");
  }

  return [
    `Published @${result.scope}/${result.name} v${result.version}`,
    `  SHA-256:  ${result.sha256}`,
    `  URL:      ${result.url}`,
  ].join("\n");
}
