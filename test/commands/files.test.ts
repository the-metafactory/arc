import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { filesListing, formatFiles, formatFilesJson } from "../../src/commands/files.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("arc files", () => {
  test("errors cleanly for a not-installed package", async () => {
    const result = await filesListing(env.db, env.arc, env.host, "Nope", { home: env.root });
    expect(result.installed).toBe(false);
    expect(result.error).toContain("not installed");
    expect(formatFiles(result)).toContain("Error:");
  });

  test("lists the artifact symlink as present after install", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "Listed" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await filesListing(env.db, env.arc, env.host, "Listed", { home: env.root });
    expect(result.installed).toBe(true);
    const symlinkEntry = result.artifacts.find((a) => a.kind === "artifact symlink" && a.liveness === "present");
    expect(symlinkEntry).toBeDefined();
    expect(symlinkEntry!.path).toBe(join(env.host.paths.skillsDir, "Listed"));
  });

  test("marks a provides.files target absent once deleted out-of-band", async () => {
    const target = join(env.root, "fake-home", "dropped.txt");
    const repo = await createMockSkillRepo(env.root, {
      name: "Provider",
      files: [{ source: "files/x", target, content: "x\n" }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Present right after install.
    let result = await filesListing(env.db, env.arc, env.host, "Provider", { home: env.root });
    expect(result.artifacts.find((a) => a.kind === "provides.files")?.liveness).toBe("present");

    // Delete out-of-band → now absent.
    await rm(target, { force: true });
    result = await filesListing(env.db, env.arc, env.host, "Provider", { home: env.root });
    expect(result.artifacts.find((a) => a.kind === "provides.files")?.liveness).toBe("absent");
  });

  test("lists owns declarations with liveness and disposition", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Owner",
      owns: {
        config: ["~/.config/metafactory/owner"],
        userData: ["~/Developer/owner-workspace"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Only the config leftover exists on disk; userData does not.
    await mkdir(join(env.root, ".config/metafactory/owner"), { recursive: true });
    await writeFile(join(env.root, ".config/metafactory/owner/system.yaml"), "x");

    const result = await filesListing(env.db, env.arc, env.host, "Owner", { home: env.root });

    const cfg = result.owns.find((o) => o.class === "config");
    expect(cfg?.disposition).toBe("purge deletes");
    expect(cfg?.matches.some((m) => m.liveness === "present")).toBe(true);

    const ud = result.owns.find((o) => o.class === "userData");
    expect(ud?.disposition).toBe("kept always");
    expect(ud?.matches.every((m) => m.liveness === "absent")).toBe(true);
  });

  test("--json output is well-formed and mirrors the structured result", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "JsonPkg",
      owns: { config: ["~/.config/metafactory/jsonpkg"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await filesListing(env.db, env.arc, env.host, "JsonPkg", { home: env.root });
    const parsed = JSON.parse(formatFilesJson(result));
    expect(parsed.name).toBe("JsonPkg");
    expect(parsed.installed).toBe(true);
    expect(Array.isArray(parsed.artifacts)).toBe(true);
    expect(parsed.owns[0].entry).toBe("~/.config/metafactory/jsonpkg");
  });
});
