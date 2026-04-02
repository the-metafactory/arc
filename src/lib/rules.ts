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

export interface GenerateResult {
  target: string;
  success: boolean;
  error?: string;
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
): Promise<GenerateResult[]> {
  const results: GenerateResult[] = [];

  for (const tmpl of templates) {
    const result = await generateSingleRule(packagePath, tmpl, consumerDir);
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
): Promise<GenerateResult> {
  const target = tmpl.target;

  // 1. Read config from consumer repo
  const configPath = join(consumerDir, tmpl.config);
  let config: RulesConfig;
  try {
    const configContent = await readFile(configPath, "utf-8");
    config = YAML.parse(configContent) as RulesConfig;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      // No config file — skip optional templates, error on required
      if (tmpl.optional) {
        return { target, success: true }; // silently skip
      }
      return { target, success: false, error: `Config file not found: ${tmpl.config}` };
    }
    return { target, success: false, error: `Failed to read config: ${err.message}` };
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
  } catch (err: any) {
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

  // 8. Write output
  const outputPath = join(consumerDir, target);
  await Bun.write(outputPath, output);

  return { target, success: true };
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
  sections: Array<{ position: string; file: string }>,
  consumerDir: string,
): Promise<string> {
  // Group sections by position
  const byPosition = new Map<string, string[]>();
  for (const section of sections) {
    const pos = section.position;
    if (!byPosition.has(pos)) byPosition.set(pos, []);

    try {
      const content = await readFile(join(consumerDir, section.file), "utf-8");
      byPosition.get(pos)!.push(content.trimEnd());
    } catch (err: any) {
      // Section file missing — skip with warning comment
      byPosition.get(pos)!.push(`<!-- Warning: section file not found: ${section.file} -->`);
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
