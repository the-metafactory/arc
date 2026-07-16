/**
 * REGISTRY.yaml generator (skill-estate migration WS6, arc#322).
 *
 * Manifests are the source of truth for the *derivable* fields (name,
 * description, version, source, trust, has_cli, bundle). But the hand-maintained
 * REGISTRY.yaml also carries curated metadata that no arc-manifest contains —
 * agent capability schemas (cortex Q2: category, risk_level, substrate, mode,
 * capabilities[]), `contributors`, `core`, `reviewed_by`, and the curated
 * lifecycle `status` (designed → scaffolded → published → shipped → deprecated),
 * plus aspirational entries (e.g. agents that have no installable repo yet).
 *
 * So this generator is MERGE-PRESERVING, not replace-all: for every scanned repo
 * it overwrites the manifest-authoritative fields on the matching entry and keeps
 * every curated field; entries with no scanned match are preserved verbatim (an
 * archived/removed repo is dropped only when explicitly scanned-and-absent is not
 * expressible here — removal stays a manual decision, per the spec's
 * "archived, not deleted"). This fixes staleness (arc 0.12.1 → real version) and
 * marks external Category-B repos `community` without destroying curated data.
 *
 * Pure module: no filesystem or network. The CLI (scripts/generate-registry.ts)
 * supplies scanned repos + the existing file; every function here is a total,
 * deterministic transform so it is directly unit-testable and its output diffs
 * cleanly on regeneration.
 */

import YAML from "yaml";
import type { ArcManifest, RegistryConfig, RegistryEntry, RegistryTrust } from "../types.js";

/** A repo discovered by the scan, paired with its parsed manifest. */
export interface ScannedRepo {
  /** Canonical clone/source URL recorded in the entry (github.com/<owner>/<repo>). */
  source: string;
  /** The repo's parsed arc-manifest.yaml. */
  manifest: ArcManifest;
  /**
   * Category-B external repo (personal org). Forces registry tier `community`
   * per spec §5.2 regardless of the manifest's own tier.
   */
  external?: boolean;
}

/** The registry sections, in canonical emit order. */
export const REGISTRY_SECTIONS = [
  "skills",
  "agents",
  "prompts",
  "tools",
  "components",
  "rules",
] as const;
export type RegistrySection = (typeof REGISTRY_SECTIONS)[number];

/**
 * Manifest `type` → registry section. `bundle` lands in `skills` (a bundle is a
 * skill-led repo shipping its tools) flagged `bundle: true`; `library` has no
 * dedicated section and maps to `tools`.
 */
export function sectionForType(type: string | undefined): RegistrySection {
  switch (type) {
    case "agent":
      return "agents";
    case "prompt":
      return "prompts";
    case "tool":
    case "library":
      return "tools";
    case "component":
      return "components";
    case "rules":
      return "rules";
    case "skill":
    case "bundle":
    default:
      return "skills";
  }
}

/**
 * Map a manifest `tier` (the package's self-declared class) to the registry
 * `trust:` word (the registry's source-trust axis, arc#324). The two vocabularies
 * are deliberately kept on SEPARATE fields now — `trust:` in REGISTRY.yaml, `tier`
 * in the manifest — so one word set no longer means two things. The value mapping
 * collapses to the registry's established trust words: `community` stays
 * `community`; everything org-internal (custom/official/core) is `custom`.
 * External repos are forced `community` by the caller before this runs.
 * See docs/registry-schema.md.
 */
export function tierToTrust(tier: string | undefined): RegistryTrust {
  return tier === "community" ? "community" : "custom";
}

/**
 * Build the manifest-authoritative slice of a registry entry for a scanned repo.
 * These are exactly the fields the generator OWNS; everything else on an existing
 * entry is curated and preserved by {@link mergeEntry}.
 */
/**
 * Manifest `type` values that are bundle-class (a strict-validator type not in
 * the loader's ArcManifest union). Typed as a string set so the comparison needs
 * no assertion.
 */
const BUNDLE_TYPE_NAMES: ReadonlySet<string> = new Set(["bundle"]);

/** The manifest-authoritative slice — the fields the generator OWNS. */
export type DerivedFields = Pick<
  RegistryEntry,
  "name" | "description" | "author" | "version" | "source" | "trust"
> & { has_cli?: boolean; bundle?: boolean };

export function manifestDerivedFields(scanned: ScannedRepo): DerivedFields {
  const m = scanned.manifest;
  const fields: DerivedFields = {
    name: m.name,
    description: m.description ?? "",
    author: m.author?.github ?? "the-metafactory",
    version: m.version,
    source: scanned.source,
    trust: scanned.external ? "community" : tierToTrust(m.tier),
  };
  if (m.provides?.cli && m.provides.cli.length > 0) fields.has_cli = true;
  if (BUNDLE_TYPE_NAMES.has(m.type)) fields.bundle = true;
  return fields;
}

/** Default lifecycle status for a brand-new (previously unlisted) entry. */
export const DEFAULT_STATUS: RegistryEntry["status"] = "shipped";

/**
 * Merge the manifest-derived fields onto an existing curated entry (or create a
 * fresh one). Manifest fields win; every other key on `existing` is preserved.
 * `status` is curated — kept from `existing`, defaulted only when brand-new.
 */
export function mergeEntry(
  derived: DerivedFields,
  existing: RegistryEntry | undefined,
): RegistryEntry {
  if (!existing) {
    return { status: DEFAULT_STATUS, ...derived };
  }
  // Preserve curated keys (contributors, core, reviewed_by, substrate, mode,
  // category, risk_level, capabilities, depends_on, status, …); overwrite only
  // the manifest-authoritative ones.
  return { ...existing, ...derived };
}

/** Case-insensitive, stable name sort for deterministic section ordering. */
function byName(a: RegistryEntry, b: RegistryEntry): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export interface GenerateResult {
  config: RegistryConfig;
  /** Names that were newly added (per section) — for the CLI report. */
  added: { section: RegistrySection; name: string }[];
  /** Names whose manifest-derived fields changed vs the existing file. */
  updated: { section: RegistrySection; name: string }[];
  /** Existing entries with no scanned repo — preserved verbatim. */
  preserved: { section: RegistrySection; name: string }[];
}

/** Every section as a required array — avoids optional-section null juggling. */
type FullRegistry = Record<RegistrySection, RegistryEntry[]>;

/** Coalesce an optional array to an empty one (generic keeps the guard honest). */
function asArray<T>(x: T[] | undefined): T[] {
  return x ?? [];
}

/** Normalize a (possibly-null, optional-section) config into a full record. */
function toFullRegistry(config: RegistryConfig | null): FullRegistry {
  const r = config?.registry;
  if (!r) return { skills: [], agents: [], prompts: [], tools: [], components: [], rules: [] };
  return {
    skills: r.skills,
    agents: r.agents,
    prompts: r.prompts,
    tools: r.tools,
    components: asArray(r.components),
    rules: asArray(r.rules),
  };
}

/**
 * Produce the merged, sorted registry from the scan plus the existing file.
 * Deterministic: same inputs ⇒ byte-identical output (see {@link serializeRegistry}).
 */
export function generateRegistry(
  scanned: ScannedRepo[],
  existing: RegistryConfig | null,
): GenerateResult {
  const base = toFullRegistry(existing);
  const out: FullRegistry = { skills: [], agents: [], prompts: [], tools: [], components: [], rules: [] };
  const added: GenerateResult["added"] = [];
  const updated: GenerateResult["updated"] = [];
  const preserved: GenerateResult["preserved"] = [];

  // Index existing entries by section+name so we can merge and track leftovers.
  const existingBySection = new Map<RegistrySection, Map<string, RegistryEntry>>();
  for (const section of REGISTRY_SECTIONS) {
    const map = new Map<string, RegistryEntry>();
    for (const e of base[section]) map.set(e.name, e);
    existingBySection.set(section, map);
  }

  const scannedKeys = new Set<string>();
  for (const repo of scanned) {
    const section = sectionForType(repo.manifest.type);
    const derived = manifestDerivedFields(repo);
    const name = derived.name;
    const prior = existingBySection.get(section)?.get(name);
    const merged = mergeEntry(derived, prior);
    out[section].push(merged);
    scannedKeys.add(`${section} ${name}`);
    if (!prior) added.push({ section, name });
    else if (
      !shallowEqual(
        prior as unknown as Record<string, unknown>,
        merged as unknown as Record<string, unknown>,
      )
    )
      updated.push({ section, name });
  }

  // Preserve existing entries that were not scanned (curated / aspirational).
  for (const section of REGISTRY_SECTIONS) {
    for (const e of base[section]) {
      if (!scannedKeys.has(`${section} ${e.name}`)) {
        out[section].push(e);
        preserved.push({ section, name: e.name });
      }
    }
  }

  // arc#324 one-time migration: the trust axis moved from the legacy `type:`
  // field to `trust:`. Preserved entries still carry `type`; merged entries carry
  // both (old `type` + new `trust`). Fold `type` into `trust` (when `trust` is
  // absent) and drop the legacy key from every entry so the output has one field.
  for (const section of REGISTRY_SECTIONS) {
    for (const e of out[section]) migrateLegacyTrust(e);
    out[section].sort(byName);
  }

  return { config: { registry: out }, added, updated, preserved };
}

/** Fold a legacy `type:` trust value into `trust:` and drop the legacy key. */
function migrateLegacyTrust(entry: RegistryEntry): void {
  const r = entry as unknown as Record<string, unknown>;
  if (r.trust === undefined && typeof r.type === "string") r.trust = r.type;
  delete r.type;
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** Header stamped on generated output so readers know not to hand-edit it. */
export const GENERATED_HEADER =
  "# REGISTRY.yaml — MetaFactory ecosystem package registry\n" +
  "#\n" +
  "# GENERATED from org scan + arc-manifest.yaml files by arc's registry generator\n" +
  "# (arc#322, `bun run registry:generate`). Do NOT hand-edit the manifest-derived\n" +
  "# fields (name, description, version, source, trust, has_cli, bundle) — they are\n" +
  "# overwritten on regeneration. Curated fields (contributors, core, reviewed_by,\n" +
  "# status, and the agents' cortex-Q2 capability schema) are preserved across runs.\n" +
  "# Regenerate + check: `bun run registry:generate --check`.\n";

/**
 * Deterministically serialize the registry to YAML. Stable key order within each
 * entry (manifest-authoritative fields first, then curated), stable section
 * order, sorted entries — so regeneration produces a clean diff.
 */
export function serializeRegistry(config: RegistryConfig): string {
  const registry: Record<string, unknown> = {};
  for (const section of REGISTRY_SECTIONS) {
    registry[section] = (config.registry[section] ?? []).map(orderEntryKeys);
  }
  // YAML.stringify preserves object key insertion order (set by orderEntryKeys)
  // and section order, so output is deterministic. lineWidth:0 disables line
  // folding so descriptions stay on one line and diffs stay clean.
  const body = YAML.stringify({ registry }, { lineWidth: 0, indent: 2 });
  return `${GENERATED_HEADER}\n${body}`;
}

/** Canonical field order for a serialized entry (deterministic diffs). */
const KEY_ORDER = [
  "name",
  "description",
  "author",
  "contributors",
  "version",
  "source",
  "trust",
  "status",
  "core",
  "has_cli",
  "bundle",
  "reviewed_by",
  "requires",
  "substrate",
  "mode",
  "category",
  "risk_level",
  "depends_on",
  "capabilities",
];

function orderEntryKeys(entry: RegistryEntry): Record<string, unknown> {
  const e = entry as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (k in e && e[k] !== undefined) ordered[k] = e[k];
  // Any keys not in KEY_ORDER, appended in sorted order for stability.
  for (const k of Object.keys(e).sort()) {
    if (!(k in ordered) && e[k] !== undefined) ordered[k] = e[k];
  }
  return ordered;
}

/**
 * `--check`: is the committed file byte-identical to a fresh regeneration?
 * Returns the diff verdict; the CLI turns `stale` into exit 1.
 */
export function isStale(committed: string, regenerated: string): boolean {
  return normalize(committed) !== normalize(regenerated);
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "") + "\n";
}
