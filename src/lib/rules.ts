/**
 * Rules template engine for arc.
 *
 * Composes agent rule files (CLAUDE.md, .cursorrules, AGENTS.md) from:
 *   1. A template file (from a rules package)
 *   2. A config file (claude-md.yaml in the consumer repo)
 *   3. Section files (repo-specific markdown content)
 *
 * Implements DD-41 (rules as distributable artifacts) with template composition.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import type { RulesTemplate, RulesConfig } from "../types.js";
import { errorMessage, isErrno } from "./errors.js";
import { canonicalMemberKey } from "./composition-identity.js";
import { templateAliasSet } from "./template-aliases.js";

export interface GenerateResult {
  target: string;
  success: boolean;
  error?: string;
  /** Absolute path written. Unset when the render was skipped or refused. */
  written?: string;
  /** True when the repo was refused for lack of declared authority (arc#423 G2). */
  refused?: boolean;
}

/** Options threading write-authority into the render (arc#423). */
export interface GenerateRulesOptions {
  /**
   * Name of the package providing the templates. When set, a consumer repo is
   * written ONLY if its config `template:` declares this package (arc#423 G2).
   * Omitted = the caller has already established authority for this directory
   * (an explicit `consumerDir`, i.e. the operator named it).
   */
  packageName?: string;
  /**
   * Other spellings of `packageName` a consumer may legitimately declare, from
   * the providing package's `provides.templateAliases`. See
   * `lib/template-aliases.ts` for why this is a set and not a prefix.
   */
  packageAliases?: readonly string[];
}

/**
 * True when `config.template` declares `packageName` as its provider.
 *
 * A MISSING `template:` is NOT a declaration: a repo that never named a provider
 * has given no package authority to rewrite its files. This is the exact
 * condition that let 136 repos be clobbered — they matched only by carrying a
 * file called `agents-md.yaml`.
 *
 * The comparison is EXACT against the package's alias set, after scope-stripping
 * and lowercasing. It used to compare `-`-delimited stems, which made
 * `template: compass-evil` authority for package `compass` — a gate answering
 * yes to a package it had never been shown.
 */
export function declaresTemplateProvider(
  config: RulesConfig,
  packageName: string,
  aliases?: readonly string[],
): boolean {
  const declared = typeof config.template === "string" ? config.template : "";
  if (!declared.trim()) return false;
  return templateAliasSet(packageName, aliases).has(canonicalMemberKey(declared));
}

/**
 * The exact `{token}` spellings this render was ASKED to substitute.
 *
 * Every non-reserved config key contributes the three forms
 * `substitutePlaceholders` emits — `{KEY}`, `{key}` and the key as written —
 * plus `{PROJECT_SPECIFIC_LABELS}`, which the render always handles. Keys whose
 * value is not a string are included deliberately: the config named the key, so
 * a token left standing for it is a failed substitution, not prose.
 */
export function declaredPlaceholders(config: RulesConfig): Set<string> {
  const declared = new Set<string>(["PROJECT_SPECIFIC_LABELS"]);
  for (const key of Object.keys(config)) {
    if (RESERVED_KEYS.has(key)) continue;
    declared.add(key.toUpperCase());
    declared.add(key.toLowerCase());
    declared.add(key);
  }
  return declared;
}

/**
 * Placeholders the config addressed that the render nonetheless left standing.
 *
 * ## Why this compares against a declared set (arc#423 MAJOR 1)
 *
 * The first cut refused on ANY `{snake_token}` surviving the render. That test
 * is refuted by the only live template there is: compass-core's
 * `CLAUDE.md.template` carries `{branch}`, `{path}`, `{slug}` and `{type}` as
 * PROSE — worktree and branch naming examples — so every legitimate
 * `arc upgrade compass` refused with "template left 4 placeholder(s)
 * unsubstituted", and the goal (never write a stub) took the feature down with it.
 *
 * A brace token is a failed substitution only when it names a key the config
 * could have supplied. A `{branch}` no config key addresses is prose, and a
 * template is allowed to contain prose. What must still fail loudly is the
 * incident's shape — a key the config DID supply whose token survived anyway (a
 * non-string value, or a token reintroduced by a section injected after
 * substitution ran) — because that is what truncates a repo's real CLAUDE.md
 * down to a stub.
 */
export function unrenderedPlaceholders(output: string, declared: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of output.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    const token = m[1];
    if (token && declared.has(token)) found.add(token);
  }
  return [...found];
}

/** Reserved config keys that are not placeholder values */
const RESERVED_KEYS = new Set([
  "template",
  "generate",
  "sections",
  "extra_labels",
]);

/**
 * Generate rule files from a rules package's templates.
 *
 * @param packagePath - Path to the cloned rules package
 * @param templates - Template declarations from the package manifest
 * @param consumerDir - Consumer repo directory (where config + sections live, and output is written)
 */
export async function generateRules(
  packagePath: string,
  templates: RulesTemplate[],
  consumerDir: string,
  opts?: GenerateRulesOptions,
): Promise<GenerateResult[]> {
  const results: GenerateResult[] = [];

  for (const tmpl of templates) {
    const result = await generateSingleRule(packagePath, tmpl, consumerDir, opts);
    results.push(result);
  }

  return results;
}

/**
 * Generate a single rule file from a template + config.
 */
async function generateSingleRule(
  packagePath: string,
  tmpl: RulesTemplate,
  consumerDir: string,
  opts?: GenerateRulesOptions,
): Promise<GenerateResult> {
  const target = tmpl.target;

  // 1. Read config from consumer repo
  const configPath = join(consumerDir, tmpl.config);
  let config: RulesConfig;
  try {
    const configContent = await readFile(configPath, "utf-8");
    const parsed: unknown = YAML.parse(configContent);
    // An EMPTY config file parses to `null`, and a document whose root is a
    // scalar or a list parses to something with no `.template`. Reading
    // `config.template` off `null` throws an uncaught TypeError out of this
    // function; neither call site wraps it, so a single empty `agents-md.yaml`
    // anywhere under the scan root aborted the whole upgrade mid-swap.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        target,
        success: false,
        refused: true,
        error:
          `refused ${consumerDir}: ${tmpl.config} is empty or is not a YAML mapping ` +
          `— it declares no template provider, so it grants no authority to write ${target}`,
      };
    }
    config = parsed as RulesConfig;
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") {
      // No config file — skip optional templates, error on required
      if (tmpl.optional) {
        return { target, success: true }; // silently skip
      }
      return { target, success: false, error: `Config file not found: ${tmpl.config}` };
    }
    return { target, success: false, error: `Failed to read config: ${errorMessage(err)}` };
  }

  // 1b. arc#423 G2 — WRITE AUTHORITY. Carrying a file named `agents-md.yaml`
  // is not consent to have CLAUDE.md rewritten. When the caller names the
  // providing package (i.e. this dir came from a SCAN, not from an operator
  // naming it), the consumer's config must declare that package via `template:`.
  if (
    opts?.packageName &&
    !declaresTemplateProvider(config, opts.packageName, opts.packageAliases)
  ) {
    const declared = typeof config.template === "string" ? config.template : "(none)";
    return {
      target,
      success: false,
      refused: true,
      error:
        `refused ${consumerDir}: ${tmpl.config} declares template "${declared}", ` +
        `not "${opts.packageName}" — not a declared consumer of this package`,
    };
  }

  // 2. Check if this format is opted-in (for optional templates)
  if (tmpl.optional) {
    const formats = config.generate?.map((g) => g.format) ?? [];
    const targetFormat = formatFromTarget(target);
    if (!formats.includes(targetFormat)) {
      return { target, success: true }; // not opted in, skip
    }
  }

  // 3. Read template from package
  const templatePath = join(packagePath, tmpl.source);
  let templateContent: string;
  try {
    templateContent = await readFile(templatePath, "utf-8");
  } catch {
    return { target, success: false, error: `Template not found: ${tmpl.source}` };
  }

  // 4. Substitute placeholders
  let output = substitutePlaceholders(templateContent, config);

  // 5. Handle extra_labels placeholder
  if (config.extra_labels?.length) {
    const labelRows = config.extra_labels
      .map((l) => `| \`${l.name}\` | | | Project-specific |`)
      .join("\n");
    output = output.replace("{PROJECT_SPECIFIC_LABELS}", labelRows);
  } else {
    output = output.replace("{PROJECT_SPECIFIC_LABELS}", "");
  }

  // 6. Inject sections at markers
  if (config.sections?.length) {
    output = await injectSections(output, config.sections, consumerDir);
  }

  // 7. Clean up any remaining injection markers
  output = output.replace(/<!-- inject:after:\S+ -->\n?/g, "");

  // 8. arc#423 G3 — a half-rendered template is an ERROR, not an output.
  // The incident's 136 files were not merely written to the wrong repo; they
  // were written as the bare stub `# {PROJECT_NAME}` — a placeholder the render
  // was asked to fill and did not. Only tokens the config ADDRESSES count;
  // prose braces in the template body are prose (see `unrenderedPlaceholders`).
  const residual = unrenderedPlaceholders(output, declaredPlaceholders(config));
  if (residual.length) {
    return {
      target,
      success: false,
      error:
        `refused ${join(consumerDir, target)}: template left ` +
        `${residual.length} placeholder(s) unsubstituted ` +
        `(${residual.map((p) => `{${p}}`).join(", ")}) — ` +
        `${tmpl.config} declares the key but the render did not populate it`,
    };
  }

  // 9. Write output
  const outputPath = join(consumerDir, target);
  await Bun.write(outputPath, output);

  return { target, success: true, written: outputPath };
}

/**
 * Substitute {placeholder} values from config into the template.
 * Only substitutes keys that are not reserved config keys.
 */
function substitutePlaceholders(template: string, config: RulesConfig): string {
  let output = template;

  for (const [key, value] of Object.entries(config)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;

    // Replace {KEY} (case-insensitive match on the key)
    const upper = key.toUpperCase();
    const lower = key.toLowerCase();
    // Try exact case, UPPER_CASE, and the key as-is
    output = output.replaceAll(`{${upper}}`, value);
    output = output.replaceAll(`{${lower}}`, value);
    output = output.replaceAll(`{${key}}`, value);
  }

  return output;
}

/**
 * Inject section file contents at `<!-- inject:after:X -->` markers.
 */
async function injectSections(
  template: string,
  sections: { position: string; file: string }[],
  consumerDir: string,
): Promise<string> {
  // Group sections by position
  const byPosition = new Map<string, string[]>();
  for (const section of sections) {
    const pos = section.position;
    let bucket = byPosition.get(pos);
    if (!bucket) {
      bucket = [];
      byPosition.set(pos, bucket);
    }

    try {
      const content = await readFile(join(consumerDir, section.file), "utf-8");
      bucket.push(content.trimEnd());
    } catch {
      // Section file missing — skip with warning comment
      bucket.push(`<!-- Warning: section file not found: ${section.file} -->`);
    }
  }

  // Replace markers with injected content
  let output = template;
  for (const [position, contents] of byPosition) {
    const marker = `<!-- inject:${position} -->`;
    const injection = contents.join("\n\n");
    output = output.replace(marker, `${injection}\n`);
  }

  return output;
}

/**
 * Map target filename to format identifier for opt-in matching.
 */
function formatFromTarget(target: string): string {
  if (target === "CLAUDE.md") return "claude-md";
  if (target === ".cursorrules") return "cursorrules";
  if (target === "AGENTS.md") return "agents-md";
  if (target === ".windsurfrules") return "windsurfrules";
  // Fallback: lowercase, replace dots and extensions
  return target.toLowerCase().replace(/\.[^.]+$/, "").replace(/\./g, "-");
}
