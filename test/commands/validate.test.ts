import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { validate } from "../../src/commands/validate.js";

let tempParent: string;

beforeEach(async () => {
  tempParent = await mkdtemp(join(tmpdir(), "arc-validate-test-"));
});

afterEach(async () => {
  await rm(tempParent, { recursive: true, force: true });
});

/** Create a package dir named `dirName` under the temp parent, return its path. */
async function makePkgDir(dirName: string): Promise<string> {
  const dir = join(tempParent, dirName);
  await mkdir(dir, { recursive: true });
  return dir;
}

const CLEAN_MANIFEST = `schema: arc/v1
name: code-review
version: 0.1.0
type: skill
tier: official
description: Multi-lens pull request review.
license: Apache-2.0
author:
  name: Jane Doe
  github: janedoe
capabilities:
  filesystem:
    read: []
    write: []
  network: []
  bash:
    allowed: false
  secrets: []
`;

describe("arc validate command", () => {
  test("exit 0 on a clean arc/v1 manifest", async () => {
    const dir = await makePkgDir("metafactory-skill-code-review");
    await writeFile(join(dir, "arc-manifest.yaml"), CLEAN_MANIFEST);

    const result = await validate(dir);
    expect(result.exitCode).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.lines[0]).toContain("OK");
  });

  test("exit 1 with a schema line — the issue's verification snippet", async () => {
    // Mirrors: printf 'schema: pai/v1\nname: x\n' > arc-manifest.yaml && arc validate
    const dir = await makePkgDir("scratch");
    await writeFile(join(dir, "arc-manifest.yaml"), "schema: pai/v1\nname: x\n");

    const result = await validate(dir);
    expect(result.exitCode).toBe(1);
    const joined = result.lines.join("\n");
    expect(joined).toContain("schema");
  });

  test("exit 1 when no manifest is present", async () => {
    const dir = await makePkgDir("empty-pkg");
    const result = await validate(dir);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("no arc-manifest.yaml");
  });

  test("one line per violation, formatted '<field>: <rule>'", async () => {
    const dir = await makePkgDir("scratch");
    await writeFile(join(dir, "arc-manifest.yaml"), "schema: pai/v1\nname: x\n");

    const result = await validate(dir);
    // Every printed line must carry the "field: rule" shape.
    for (const line of result.lines) {
      expect(line).toMatch(/^[^:]+: .+/);
    }
    // The line count equals the violation count (one line each).
    expect(result.lines.length).toBe(result.violations.length);
  });

  test("exit 1 on malformed YAML", async () => {
    const dir = await makePkgDir("scratch");
    await writeFile(join(dir, "arc-manifest.yaml"), "schema: arc/v1\n  : : : bad\n\t- broken");

    const result = await validate(dir);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("manifest");
  });

  test("enforces the SKILL.md PascalCase rule when a SKILL.md is present", async () => {
    const dir = await makePkgDir("metafactory-skill-code-review");
    await writeFile(join(dir, "arc-manifest.yaml"), CLEAN_MANIFEST);
    await mkdir(join(dir, "skill"), { recursive: true });
    // Wrong: frontmatter name should be PascalCase "CodeReview".
    await writeFile(join(dir, "skill", "SKILL.md"), "---\nname: code-review\n---\n# body\n");

    const result = await validate(dir);
    expect(result.exitCode).toBe(1);
    expect(result.violations.some((v) => v.field === "SKILL.md:name")).toBe(true);
  });

  test("clean manifest + correct PascalCase SKILL.md → exit 0", async () => {
    const dir = await makePkgDir("metafactory-skill-code-review");
    await writeFile(join(dir, "arc-manifest.yaml"), CLEAN_MANIFEST);
    await writeFile(join(dir, "SKILL.md"), "---\nname: CodeReview\n---\n# body\n");

    const result = await validate(dir);
    expect(result.exitCode).toBe(0);
  });

  test("falls back to the legacy pai-manifest.yaml filename", async () => {
    const dir = await makePkgDir("metafactory-skill-code-review");
    // Legacy filename still carrying the rejected pai/v1 schema → still parsed,
    // still validated, and (correctly) flagged on schema.
    await writeFile(join(dir, "pai-manifest.yaml"), CLEAN_MANIFEST.replace("arc/v1", "pai/v1"));

    const result = await validate(dir);
    expect(result.exitCode).toBe(1);
    expect(result.violations.some((v) => v.field === "schema")).toBe(true);
  });
});
