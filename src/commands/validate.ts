/**
 * `arc validate [path]` — strict arc/v1 manifest validation (arc#317).
 *
 * The WS2 migration gate: certify that a package repo's arc-manifest.yaml (and
 * its SKILL.md, when present) conforms to the strict skill-repo-migration
 * contract (spec §4.1/§4.2) BEFORE it is published/migrated. Opt-in and
 * read-only — it does NOT change how `arc install` parses manifests (the loader
 * stays lenient; the `pai/v1` alias removal is arc#280).
 *
 * Output contract: exit 0 and a one-line OK on a clean manifest; exit 1 with one
 * line per violation (`<field>: <rule>`) otherwise.
 */

import { readFile } from "fs/promises";
import { basename, join, resolve } from "path";
import YAML from "yaml";
import {
  MANIFEST_FILENAME,
  LEGACY_MANIFEST_FILENAME,
} from "../lib/manifest.js";
import { validateStrictManifest, type Violation } from "../lib/validate-manifest.js";
import { isErrno } from "../lib/errors.js";

/** Candidate SKILL.md locations, in resolution order (spec §4.1: `path: skill/`). */
const SKILL_MD_CANDIDATES = ["skill/SKILL.md", "SKILL.md"] as const;

export interface ValidateResult {
  /** Absolute path to the manifest that was validated, or null if none found. */
  manifestPath: string | null;
  /** Collected violations (empty ⇒ valid). */
  violations: Violation[];
  /** Process exit code: 0 clean, 1 any violation or a load/parse failure. */
  exitCode: 0 | 1;
  /** Human-readable report lines (violations, or the OK line). */
  lines: string[];
}

/**
 * Run strict validation over the package directory at `targetPath` (default cwd).
 * Pure with respect to process state — returns the result; the CLI wrapper does
 * the printing and `process.exit`. This keeps it directly unit-testable.
 */
export async function validate(targetPath: string): Promise<ValidateResult> {
  const dir = resolve(targetPath);
  const repoDirName = basename(dir);

  const loaded = await loadManifestSource(dir);
  if (loaded === null) {
    const rule = `no ${MANIFEST_FILENAME} (or legacy ${LEGACY_MANIFEST_FILENAME}) found in ${dir}`;
    return {
      manifestPath: null,
      violations: [{ field: "manifest", rule }],
      exitCode: 1,
      lines: [`manifest: ${rule}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(loaded.content);
  } catch (err) {
    const rule = `is not valid YAML: ${err instanceof Error ? err.message : String(err)}`;
    return {
      manifestPath: loaded.path,
      violations: [{ field: "manifest", rule }],
      exitCode: 1,
      lines: [`manifest: ${rule}`],
    };
  }

  const skillFrontmatterName = await readSkillFrontmatterName(dir);

  const violations = validateStrictManifest({
    manifest: parsed,
    repoDirName,
    skillFrontmatterName,
  });

  if (violations.length === 0) {
    return {
      manifestPath: loaded.path,
      violations,
      exitCode: 0,
      lines: [`OK: ${loaded.path} is a valid arc/v1 manifest`],
    };
  }

  return {
    manifestPath: loaded.path,
    violations,
    exitCode: 1,
    lines: violations.map((v) => `${v.field}: ${v.rule}`),
  };
}

/** Read the manifest file, preferring arc-manifest.yaml over the legacy name. */
async function loadManifestSource(
  dir: string,
): Promise<{ path: string; content: string } | null> {
  for (const filename of [MANIFEST_FILENAME, LEGACY_MANIFEST_FILENAME]) {
    const path = join(dir, filename);
    try {
      const content = await readFile(path, "utf-8");
      return { path, content };
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

/**
 * Read the `name:` from the package's SKILL.md frontmatter.
 * Returns:
 *   - `undefined` when no SKILL.md is found (the PascalCase rule is skipped),
 *   - `null` when a SKILL.md exists but declares no frontmatter `name`,
 *   - the string value otherwise.
 */
async function readSkillFrontmatterName(dir: string): Promise<string | null | undefined> {
  for (const candidate of SKILL_MD_CANDIDATES) {
    let content: string;
    try {
      content = await readFile(join(dir, candidate), "utf-8");
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") continue;
      throw err;
    }
    return extractFrontmatterName(content);
  }
  return undefined;
}

/**
 * Pull `name:` out of a leading `---`-delimited YAML frontmatter block. Returns
 * the string name, or `null` when the frontmatter is absent, unparseable, or
 * carries no string `name`.
 */
export function extractFrontmatterName(markdown: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  try {
    const front = YAML.parse(match[1]) as { name?: unknown } | null;
    const name = front?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
