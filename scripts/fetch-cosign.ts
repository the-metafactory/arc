#!/usr/bin/env bun
/**
 * Download cosign binaries for all supported platforms.
 * Verifies each binary's SHA-256 against the published checksums file.
 *
 * Trust model: checksums are fetched from the same GitHub release as the
 * binaries. This protects against CDN/transit tampering but not a compromised
 * release. Since cosign releases are themselves Sigstore-signed, a future
 * hardening step could verify the release signature (bootstrap verification).
 *
 * Usage: bun scripts/fetch-cosign.ts [--version v3.0.6]
 */

import { writeFile, mkdir, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const DEFAULT_VERSION = "v3.0.6";
const VENDOR_DIR = join(import.meta.dir, "..", "vendor", "cosign");

interface PlatformBinary {
  platform: string;
  arch: string;
  filename: string;
  url: string;
}

function getBinaries(version: string): PlatformBinary[] {
  const base = `https://github.com/sigstore/cosign/releases/download/${version}`;
  return [
    { platform: "darwin", arch: "arm64", filename: "cosign-darwin-arm64", url: `${base}/cosign-darwin-arm64` },
    { platform: "darwin", arch: "amd64", filename: "cosign-darwin-amd64", url: `${base}/cosign-darwin-amd64` },
    { platform: "linux", arch: "amd64", filename: "cosign-linux-amd64", url: `${base}/cosign-linux-amd64` },
  ];
}

async function fetchChecksums(version: string): Promise<Map<string, string>> {
  const url = `https://github.com/sigstore/cosign/releases/download/${version}/cosign_checksums.txt`;
  console.log(`Fetching checksums: ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch checksums: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  const checksums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match) {
      checksums.set(match[2].trim(), match[1]);
    }
  }
  return checksums;
}

function computeSha256(buffer: ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return hasher.digest("hex");
}

async function main() {
  const versionArg = process.argv.find((a) => a.startsWith("--version"));
  let version = DEFAULT_VERSION;
  if (versionArg) {
    // Support both --version v3.0.6 and --version=v3.0.6
    version = versionArg.includes("=")
      ? versionArg.split("=")[1]
      : process.argv[process.argv.indexOf(versionArg) + 1];
  }

  if (!version.startsWith("v")) {
    console.error("Version must start with 'v' (e.g., v3.0.6)");
    process.exit(1);
  }

  console.log(`\nFetching cosign ${version} binaries...\n`);

  if (!existsSync(VENDOR_DIR)) {
    await mkdir(VENDOR_DIR, { recursive: true });
  }

  const checksums = await fetchChecksums(version);
  const binaries = getBinaries(version);
  let allOk = true;

  for (const bin of binaries) {
    const destPath = join(VENDOR_DIR, bin.filename);

    if (existsSync(destPath)) {
      console.log(`  ${bin.filename}: already exists, verifying...`);
      const existing = await Bun.file(destPath).arrayBuffer();
      const hash = computeSha256(existing);
      const expected = checksums.get(bin.filename);
      if (expected && hash === expected) {
        console.log(`  ${bin.filename}: checksum OK`);
        continue;
      }
      console.log(`  ${bin.filename}: checksum mismatch, re-downloading`);
    }

    console.log(`  Downloading ${bin.filename}...`);
    const response = await fetch(bin.url, {
      signal: AbortSignal.timeout(120_000),
      redirect: "follow",
    });

    if (!response.ok) {
      console.error(`  FAILED: ${response.status} ${response.statusText}`);
      allOk = false;
      continue;
    }

    const buffer = await response.arrayBuffer();
    const hash = computeSha256(buffer);

    const expected = checksums.get(bin.filename);
    if (!expected) {
      console.error(`  WARNING: no checksum found for ${bin.filename} in checksums file`);
    } else if (hash !== expected) {
      console.error(`  FAILED: checksum mismatch for ${bin.filename}`);
      console.error(`    expected: ${expected}`);
      console.error(`    actual:   ${hash}`);
      allOk = false;
      continue;
    } else {
      console.log(`  ${bin.filename}: checksum verified`);
    }

    await writeFile(destPath, Buffer.from(buffer));
    await chmod(destPath, 0o755);
    console.log(`  ${bin.filename}: saved (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  }

  // Write version marker
  await writeFile(join(VENDOR_DIR, "VERSION"), version + "\n");

  if (!allOk) {
    console.error("\nSome binaries failed to download or verify.");
    process.exit(1);
  }

  console.log(`\nAll cosign ${version} binaries downloaded and verified.`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
