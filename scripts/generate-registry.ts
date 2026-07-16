#!/usr/bin/env bun
/**
 * `bun run registry:generate [--check] [options]` — regenerate REGISTRY.yaml
 * from a the-metafactory org scan + arc-manifest.yaml files (skill-estate
 * migration WS6, arc#322). Manifests are the source of truth; curated fields are
 * preserved (see src/lib/registry-generator.ts).
 *
 * Modes:
 *   --check            Regenerate in memory and exit 1 if the committed file is
 *                      stale (CI gate). Prints nothing but the verdict.
 *   (default)          Write the regenerated file to --output.
 *
 * Inputs:
 *   --output <path>    REGISTRY.yaml to write / check (default: ./REGISTRY.yaml).
 *   --allowlist <path> Category-B external repos, tier community (default:
 *                      scripts/registry-allowlist.yaml).
 *   --org <name>       GitHub org to scan (default: the-metafactory).
 *   --scan-input <p>   Skip the live `gh` scan; read the repo+manifest list from
 *                      a JSON file ([{ source, manifest, external? }]). Lets the
 *                      scan run where this process can't reach the network
 *                      (gather with `gh api` separately) and keeps runs
 *                      reproducible.
 *
 * The live scan shells out to `gh` (repo list + per-repo manifest fetch); the
 * network lives in the gh subprocess. The pure transform is in the lib and is
 * unit-tested; this file is the thin I/O shell.
 */

import { readFile, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { loadRegistry } from "../src/lib/registry.js";
import {
  generateRegistry,
  serializeRegistry,
  isStale,
  type ScannedRepo,
  type GenerateResult,
} from "../src/lib/registry-generator.js";
import type { ArcManifest } from "../src/types.js";

interface Args {
  check: boolean;
  output: string;
  allowlist: string;
  org: string;
  scanInput?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    check: false,
    output: "REGISTRY.yaml",
    allowlist: join(dirname(new URL(import.meta.url).pathname), "registry-allowlist.yaml"),
    org: "the-metafactory",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--allowlist") args.allowlist = argv[++i];
    else if (a === "--org") args.org = argv[++i];
    else if (a === "--scan-input") args.scanInput = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

/** Run `gh` and return stdout, or null on any non-zero exit (missing file etc.). */
function gh(ghArgs: string[]): string | null {
  const r = spawnSync("gh", ghArgs, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout;
}

/** List non-archived repos in the org (name only). */
function listOrgRepos(org: string): string[] {
  const out = gh(["repo", "list", org, "--no-archived", "--limit", "500", "--json", "name"]);
  if (!out) throw new Error(`gh repo list ${org} failed (is gh authenticated?)`);
  return (JSON.parse(out) as { name: string }[]).map((r) => r.name);
}

/** Fetch + parse a repo's arc-manifest.yaml; null when absent or invalid. */
function fetchManifest(owner: string, repo: string): ArcManifest | null {
  const b64 = gh(["api", `repos/${owner}/${repo}/contents/arc-manifest.yaml`, "-q", ".content"]);
  if (!b64) return null;
  let manifest: ArcManifest | null;
  try {
    const text = Buffer.from(b64, "base64").toString("utf-8");
    manifest = YAML.parse(text) as ArcManifest | null;
  } catch {
    return null;
  }
  // Only the top-level fields the registry derives are needed (name/description/
  // version/type/tier/author/provides.cli); a bare parse suffices and avoids
  // failing the whole scan on an unrelated strict-schema quirk. Require a name.
  if (!manifest || typeof manifest.name !== "string" || !manifest.name) return null;
  return manifest;
}

/**
 * Is a manifest fit for a registry entry? It must carry the fields every entry
 * (and arc's own `arc search`) require: a whitespace-free name (the naming
 * standard is lowercase-hyphenated or PascalCase — a spaced name is a template/
 * example) and a non-empty description. The strict validator requires both, so a
 * failure here is a non-conformant manifest — we skip it and REPORT the reason
 * (never silently) so the owner fixes it and it lands next run.
 */
function publishabilityReason(manifest: ArcManifest): string | null {
  if (!manifest.name || /\s/.test(manifest.name)) return "non-publishable name (whitespace/empty)";
  if (typeof manifest.description !== "string" || manifest.description.trim() === "")
    return "missing description";
  return null;
}

/** Live org scan + external allowlist via gh. Collects skipped repos for the report. */
function liveScan(
  org: string,
  external: { owner: string; repo: string }[],
  skipped: { source: string; name: string; reason: string }[],
): ScannedRepo[] {
  const scanned: ScannedRepo[] = [];
  const consider = (source: string, manifest: ArcManifest | null, isExternal: boolean) => {
    if (!manifest) return;
    const reason = publishabilityReason(manifest);
    if (reason) {
      skipped.push({ source, name: manifest.name || "(unnamed)", reason });
      return;
    }
    scanned.push({ source, manifest, external: isExternal || undefined });
  };
  for (const name of listOrgRepos(org)) {
    consider(`https://github.com/${org}/${name}`, fetchManifest(org, name), false);
  }
  for (const { owner, repo } of external) {
    consider(`https://github.com/${owner}/${repo}`, fetchManifest(owner, repo), true);
  }
  return scanned;
}

async function loadAllowlist(path: string): Promise<{ owner: string; repo: string }[]> {
  try {
    const raw = YAML.parse(await readFile(path, "utf-8")) as { external?: string[] } | null;
    return (raw?.external ?? []).map((slug) => {
      const [owner, repo] = slug.split("/");
      return { owner, repo };
    });
  } catch {
    return [];
  }
}

function reportLines(
  res: GenerateResult,
  skipped: { source: string; name: string; reason: string }[],
): string[] {
  const lines: string[] = [];
  const fmt = (xs: { section: string; name: string }[]) =>
    xs.map((x) => `${x.section}/${x.name}`).sort().join(", ") || "none";
  lines.push(`added:     ${fmt(res.added)}`);
  lines.push(`updated:   ${fmt(res.updated)}`);
  lines.push(`preserved: ${res.preserved.length} entr${res.preserved.length === 1 ? "y" : "ies"} not scanned (curated/aspirational or manifest-less)`);
  if (skipped.length) {
    lines.push(
      `skipped:   ${skipped.map((s) => `${s.name} — ${s.reason} (${s.source})`).sort().join("; ")}`,
    );
  }
  // recall (arc#322 note): the generator keys off manifests, not repos.yaml, so a
  // repo missing from repos.yaml still lands here if it has a manifest. Surface
  // any such repo rather than deciding registration policy.
  const recall = [...res.added, ...res.updated].filter((x) => x.name === "recall");
  if (recall.length) {
    lines.push(
      "note: `recall` is present via its manifest but has no compass/ecosystem/repos.yaml entry — registration policy is a flagged decision (not resolved here).",
    );
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const skipped: { source: string; name: string; reason: string }[] = [];
  let scanned: ScannedRepo[];
  if (args.scanInput) {
    scanned = JSON.parse(await readFile(args.scanInput, "utf-8")) as ScannedRepo[];
  } else {
    const external = await loadAllowlist(args.allowlist);
    scanned = liveScan(args.org, external, skipped);
  }

  const existing = await loadRegistry(args.output);
  const result = generateRegistry(scanned, existing);
  const output = serializeRegistry(result.config);

  if (args.check) {
    let committed = "";
    try {
      committed = await readFile(args.output, "utf-8");
    } catch {
      committed = "";
    }
    const stale = isStale(committed, output);
    if (stale) {
      console.error(`REGISTRY.yaml is STALE — run \`bun run registry:generate\` to update ${basename(args.output)}.`);
      for (const l of reportLines(result, skipped)) console.error(`  ${l}`);
      process.exit(1);
    }
    console.log(`REGISTRY.yaml is up to date (${basename(args.output)}).`);
    return;
  }

  await writeFile(args.output, output, "utf-8");
  console.log(`Wrote ${args.output}`);
  for (const l of reportLines(result, skipped)) console.log(`  ${l}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
