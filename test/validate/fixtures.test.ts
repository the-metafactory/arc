import { describe, test, expect } from "bun:test";
import { join } from "path";
import { validate, type ValidateResult } from "../../src/commands/validate.js";
import type { Violation } from "../../src/lib/validate-manifest.js";

/**
 * Fixture corpus for the strict `arc validate` gate (arc#318, epic arc#316).
 *
 * These are on-disk fixtures — real arc-manifest.yaml (and SKILL.md) files under
 * test/fixtures/manifests/ — driven through the actual `validate()` command so
 * the corpus exercises manifest loading, SKILL.md frontmatter resolution, and
 * the §4.2 repo-dir derivation together (the pure-function paths are covered by
 * test/unit/validate-manifest.test.ts). Every drift shape below was observed in
 * the wild 2026-07-16; each failing test asserts the specific violation string
 * emitted by src/lib/validate-manifest.ts, not an invented one.
 */

const MANIFESTS_DIR = join(import.meta.dir, "..", "fixtures", "manifests");
const passingDir = (name: string) => join(MANIFESTS_DIR, "passing", name);
const failingDir = (name: string) => join(MANIFESTS_DIR, "failing", name);

/** Find the violation for a dotted field, or fail loudly with the full report. */
function violation(result: ValidateResult, field: string): Violation {
  const v = result.violations.find((x) => x.field === field);
  if (!v) {
    throw new Error(
      `expected a violation on '${field}', got:\n${result.lines.join("\n")}`,
    );
  }
  return v;
}

// One PASSING manifest per artifact type, plus a bundle-style skill repo. Each
// dir name is chosen so the §4.2 derivation either matches (skill/bundle) or is
// skipped (the dir does not match the metafactory grammar) — never violated.
const PASSING_FIXTURES = [
  "metafactory-skill-code-review", // skill (+ PascalCase SKILL.md)
  "metafactory-tool-formatter", // tool
  "metafactory-agent-scout", // agent
  "metafactory-prompt-summarize", // prompt
  "metafactory-component-datatable", // component
  "metafactory-pipeline-nightly", // pipeline
  "metafactory-action-notify", // action (arc#95)
  "metafactory-bundle-devkit", // bundle-style skill repo w/ provides.cli+commands
] as const;

describe("arc#318 fixture corpus — passing (one per artifact type)", () => {
  for (const name of PASSING_FIXTURES) {
    test(`${name} validates clean (exit 0, no violations)`, async () => {
      const result = await validate(passingDir(name));
      // On failure, surface the offending lines so a regression is diagnosable.
      expect(result.violations).toEqual([]);
      expect(result.exitCode).toBe(0);
      expect(result.lines[0]).toContain("OK");
    });
  }
});

describe("arc#318 fixture corpus — failing (one per drift class)", () => {
  // Drift class 1: schema: pai/v1 (release-manager / plan-breakdown today).
  test("schema-pai-v1: rejects the pai/v1 alias and names arc#280", async () => {
    const result = await validate(failingDir("schema-pai-v1"));
    expect(result.exitCode).toBe(1);
    const v = violation(result, "schema");
    expect(v.rule).toBe(
      "must be 'arc/v1' — the 'pai/v1' alias is rejected in strict mode (alias removal tracked in arc#280)",
    );
  });

  // Drift class 2: missing schema: (pai-skill-sop today).
  test("missing-schema: flags an absent schema key", async () => {
    const result = await validate(failingDir("missing-schema"));
    expect(result.exitCode).toBe(1);
    const v = violation(result, "schema");
    expect(v.rule).toBe(
      "is required and must be the literal 'arc/v1' (arc#280)",
    );
  });

  // Drift class 3: authors: list (soma / bundle-discord today).
  test("authors-list: rejects the plural authors list shape (arc#278)", async () => {
    const result = await validate(failingDir("authors-list"));
    expect(result.exitCode).toBe(1);
    const v = violation(result, "authors");
    expect(v.rule).toBe(
      "the 'authors:' list shape is rejected — use the singular 'author: {name, github}' map (arc#278)",
    );
  });

  // Drift class 4: missing capabilities block (release-manager today).
  test("missing-capabilities: flags the absent required block (arc#240)", async () => {
    const result = await validate(failingDir("missing-capabilities"));
    expect(result.exitCode).toBe(1);
    const v = violation(result, "capabilities");
    expect(v.rule).toBe(
      "is a required block with explicit empties (filesystem/network/bash/secrets) — never omitted (arc#240)",
    );
  });

  // Drift class 5: network entry shapes — legacy { domain, reason } map AND the
  // bare-URL-string shorthand (arc + legacy SKILL.md schema today).
  test("network-legacy-shapes: rejects both the domain map and the bare-string entry", async () => {
    const result = await validate(failingDir("network-legacy-shapes"));
    expect(result.exitCode).toBe(1);

    // Entry 0: { domain, reason } → no `host` present.
    const host = violation(result, "capabilities.network[0].host");
    expect(host.rule).toBe(
      "is required (the { domain, reason } shape is rejected — use 'host')",
    );

    // Entry 1: bare URL string → shorthand rejected.
    const shorthand = violation(result, "capabilities.network[1]");
    expect(shorthand.rule).toBe(
      'must be a { host, reason } object only — string shorthand is rejected; got "https://api.example.com"',
    );
  });

  // Drift class 6: repo/manifest name mismatch — dir metafactory-skill-release-manager
  // derives `release-manager`, but the manifest declares `name: ReleaseManager`.
  test("name-mismatch: manifest name must derive from the repo directory (§4.2)", async () => {
    const result = await validate(failingDir("metafactory-skill-release-manager"));
    expect(result.exitCode).toBe(1);
    const derivation = result.violations.find(
      (v) => v.field === "name" && v.rule.includes("§4.2"),
    );
    if (!derivation) {
      throw new Error(
        `expected a §4.2 name-derivation violation, got:\n${result.lines.join("\n")}`,
      );
    }
    expect(derivation.rule).toBe(
      "must derive from repo directory 'metafactory-skill-release-manager' → 'release-manager' (spec §4.2); got 'ReleaseManager'",
    );
  });
});
