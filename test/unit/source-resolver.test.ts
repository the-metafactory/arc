import { describe, test, expect } from "bun:test";
import { resolveSource, parseDependencyRef } from "../../src/lib/source-resolver.js";
import { homedir } from "os";
import { resolve } from "path";

describe("resolveSource", () => {
  describe("local paths", () => {
    test("absolute path", () => {
      const result = resolveSource("/Users/me/Developer/pai-skill-jira/skill/SKILL.md");
      expect(result.type).toBe("local");
      expect(result.cloneUrl).toBe("/Users/me/Developer/pai-skill-jira/skill");
      expect(result.parentPath).toBe("/Users/me/Developer/pai-skill-jira/skill");
      expect(result.filename).toBe("SKILL.md");
      expect(result.org).toBeUndefined();
      expect(result.repo).toBeUndefined();
      expect(result.branch).toBeUndefined();
    });

    test("tilde path expands to homedir", () => {
      const result = resolveSource("~/Developer/my-skill/SKILL.md");
      const home = homedir();
      expect(result.type).toBe("local");
      expect(result.cloneUrl).toBe(resolve(home, "Developer/my-skill"));
      expect(result.parentPath).toBe(resolve(home, "Developer/my-skill"));
      expect(result.filename).toBe("SKILL.md");
    });

    test("agent file in nested dir", () => {
      const result = resolveSource("/Users/me/.claude/agents/Architect.md");
      expect(result.type).toBe("local");
      expect(result.cloneUrl).toBe("/Users/me/.claude/agents");
      expect(result.parentPath).toBe("/Users/me/.claude/agents");
      expect(result.filename).toBe("Architect.md");
    });
  });

  describe("GitHub browser URLs", () => {
    test("standard blob URL", () => {
      const result = resolveSource(
        "https://github.com/danielmiessler/pai/blob/main/skills/Research/SKILL.md"
      );
      expect(result.type).toBe("github");
      expect(result.cloneUrl).toBe("https://github.com/danielmiessler/pai.git");
      expect(result.org).toBe("danielmiessler");
      expect(result.repo).toBe("pai");
      expect(result.branch).toBe("main");
      expect(result.parentPath).toBe("skills/Research");
      expect(result.filename).toBe("SKILL.md");
    });

    test("nested skill path", () => {
      const result = resolveSource(
        "https://github.com/danielmiessler/pai/blob/main/skills/Thinking/Council/SKILL.md"
      );
      expect(result.type).toBe("github");
      expect(result.cloneUrl).toBe("https://github.com/danielmiessler/pai.git");
      expect(result.branch).toBe("main");
      expect(result.parentPath).toBe("skills/Thinking/Council");
      expect(result.filename).toBe("SKILL.md");
    });

    test("non-main branch", () => {
      const result = resolveSource(
        "https://github.com/jcfischer/specflow-bundle/blob/develop/skill/SKILL.md"
      );
      expect(result.type).toBe("github");
      expect(result.cloneUrl).toBe("https://github.com/jcfischer/specflow-bundle.git");
      expect(result.org).toBe("jcfischer");
      expect(result.repo).toBe("specflow-bundle");
      expect(result.branch).toBe("develop");
      expect(result.parentPath).toBe("skill");
      expect(result.filename).toBe("SKILL.md");
    });

    test("file at repo root", () => {
      const result = resolveSource(
        "https://github.com/danielmiessler/pai/blob/main/Architect.md"
      );
      expect(result.type).toBe("github");
      expect(result.parentPath).toBe(".");
      expect(result.filename).toBe("Architect.md");
    });

    test("throws on invalid GitHub URL (no blob)", () => {
      expect(() =>
        resolveSource("https://github.com/org/repo/tree/main/path")
      ).toThrow("Invalid GitHub browser URL");
    });

    test("throws on too-short GitHub URL", () => {
      expect(() =>
        resolveSource("https://github.com/org/repo")
      ).toThrow("Invalid GitHub browser URL");
    });
  });

  describe("GitHub raw URLs", () => {
    test("standard raw URL", () => {
      const result = resolveSource(
        "https://raw.githubusercontent.com/danielmiessler/pai/main/skills/Research/SKILL.md"
      );
      expect(result.type).toBe("github");
      expect(result.cloneUrl).toBe("https://github.com/danielmiessler/pai.git");
      expect(result.org).toBe("danielmiessler");
      expect(result.repo).toBe("pai");
      expect(result.branch).toBe("main");
      expect(result.parentPath).toBe("skills/Research");
      expect(result.filename).toBe("SKILL.md");
    });

    test("agent raw URL", () => {
      const result = resolveSource(
        "https://raw.githubusercontent.com/danielmiessler/pai/main/agents/Architect.md"
      );
      expect(result.type).toBe("github");
      expect(result.parentPath).toBe("agents");
      expect(result.filename).toBe("Architect.md");
    });

    test("file at repo root via raw URL", () => {
      const result = resolveSource(
        "https://raw.githubusercontent.com/org/repo/main/README.md"
      );
      expect(result.type).toBe("github");
      expect(result.parentPath).toBe(".");
      expect(result.filename).toBe("README.md");
    });

    test("throws on too-short raw URL", () => {
      expect(() =>
        resolveSource("https://raw.githubusercontent.com/org/repo")
      ).toThrow("Invalid GitHub raw URL");
    });
  });
});

describe("parseDependencyRef", () => {
  test("skill:Name", () => {
    const result = parseDependencyRef("skill:Thinking");
    expect(result.artifactType).toBe("skill");
    expect(result.name).toBe("Thinking");
  });

  test("agent:Name", () => {
    const result = parseDependencyRef("agent:Architect");
    expect(result.artifactType).toBe("agent");
    expect(result.name).toBe("Architect");
  });

  test("prompt:Name", () => {
    const result = parseDependencyRef("prompt:task-router");
    expect(result.artifactType).toBe("prompt");
    expect(result.name).toBe("task-router");
  });

  test("no prefix defaults to skill", () => {
    const result = parseDependencyRef("Research");
    expect(result.artifactType).toBe("skill");
    expect(result.name).toBe("Research");
  });

  test("throws on invalid type prefix", () => {
    expect(() => parseDependencyRef("widget:Foo")).toThrow(
      'Invalid dependency type "widget"'
    );
  });
});
