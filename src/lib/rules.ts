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
}

/**
 * Reduce a template identifier to its stem — the first `-`-delimited segment,
 * lowercased.
 *
 * Live consumer configs in the wild spell the SAME provider three ways:
 * crucible says `compass-core`, cortex and halden say `compass-standards`, and
 * the installed package is `compass`. Requiring an exact string match would
 * refuse every real consumer and break the feature the gate is meant to protect;
 * comparing stems accepts all three while still refusing an unrelated package
 * (`OverlayPkg` vs `compass-core`) — which is the whole of arc#423.
 */
function templateStem(id: string): string {
  return id.trim().toLowerCase().split("-")[0] ?? "";
}

/**
 * True when `config.template` declares `packageName` as its provider.
 *
 * A MISSING `template:` is NOT a declaration: a repo that never named a provider
 * has given no package authority to rewrite its files. This is the exact
 * condition that let 136 repos be clobbered — they matched only by carrying a
 * file called `agents-md.yaml`.
 */
export function declaresTemplateProvider(
  config: RulesConfig,
  packageName: string,
): boolean {
  const declared = typeof config.template === "string" ? config.template : "";
  if (!declared) return false;
  if (declared.toLowerCase() === packageName.toLowerCase()) return true;
  return templateStem(declared) === templateStem(packageName);
}

/**
 * Placeholders still unsubstituted after a render — `{FOO}` / `{foo_bar}`.
 *
 * Deliberately narrow: ALL-CAPS or all-lower snake tokens only, so ordinary
 * prose braces and code samples in a template body are not mistaken for
 * placeholders.
 */
export function residualPlaceholders(output: string): string[] {
  const found = new Set<string>();
  for (const m of output.matchAll(/\{([A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)\}/g)) {
    if (m[1]) found.add(m[1]);
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
    config = YAML.parse(configContent) as RulesConfig;
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
  if (opts?.packageName && !declaresTemplateProvider(config, opts.packageName)) {
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
  // were written as the bare stub `# {PROJECT_NAME}`, because the real configs
  // key on `repo_name` and the substitution left the placeholder standing. A
  // render that could not populate its placeholders has produced nothing worth
  // writing, so it must fail loudly rather than truncate a real file to a stub.
  const residual = residualPlaceholders(output);
  if (residual.length) {
    return {
      target,
      success: false,
      error:
        `refused ${join(consumerDir, target)}: template left ` +
        `${residual.length} placeholder(s) unsubstituted ` +
        `(${residual.map((p) => `{${p}}`).join(", ")}) — ` +
        `${tmpl.config} supplies no value for them`,
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
