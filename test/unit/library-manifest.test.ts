import { describe, test, expect } from "bun:test";
import { readManifest, readLibraryArtifacts } from "../../src/lib/manifest.js";
import { createTestEnv, createMockLibraryRepo, type TestEnv } from "../helpers/test-env.js";
import { join } from "path";

let env: TestEnv;

describe("library manifest parsing", () => {
  test("readManifest accepts library type without capabilities", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill" },
        { path: "skills/beta", name: "beta", type: "skill" },
      ],
    });

    const manifest = await readManifest(lib.path);
    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe("library");
    expect(manifest!.name).toBe("test-lib");
    expect(manifest!.artifacts).toHaveLength(2);
    expect(manifest!.artifacts![0].path).toBe("skills/alpha");
    expect(manifest!.artifacts![1].path).toBe("skills/beta");
    await env.cleanup();
  });

  test("readManifest rejects library without artifacts array", async () => {
    env = await createTestEnv();
    const dir = join(env.root, "bad-lib");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      "name: bad-lib\nversion: 1.0.0\ntype: library\n"
    );

    await expect(readManifest(dir)).rejects.toThrow("non-empty 'artifacts' array");
    await env.cleanup();
  });

  test("readManifest rejects library with capabilities field", async () => {
    env = await createTestEnv();
    const dir = join(env.root, "bad-lib-caps");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "name: bad-lib",
        "version: 1.0.0",
        "type: library",
        "artifacts:",
        "  - path: skills/a",
        "capabilities:",
        "  filesystem:",
        "    read: ['./']",
      ].join("\n")
    );

    await expect(readManifest(dir)).rejects.toThrow("must not contain 'capabilities'");
    await env.cleanup();
  });

  test("readManifest rejects library with provides field", async () => {
    env = await createTestEnv();
    const dir = join(env.root, "bad-lib-provides");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "name: bad-lib",
        "version: 1.0.0",
        "type: library",
        "artifacts:",
        "  - path: skills/a",
        "provides:",
        "  skill:",
        "    - trigger: foo",
      ].join("\n")
    );

    await expect(readManifest(dir)).rejects.toThrow("must not contain 'provides'");
    await env.cleanup();
  });

  test("readManifest rejects library with scripts field", async () => {
    env = await createTestEnv();
    const dir = join(env.root, "bad-lib-scripts");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "name: bad-lib",
        "version: 1.0.0",
        "type: library",
        "artifacts:",
        "  - path: skills/a",
        "scripts:",
        "  postinstall: ./run.sh",
      ].join("\n")
    );

    await expect(readManifest(dir)).rejects.toThrow("must not contain 'scripts'");
    await env.cleanup();
  });

  test("readManifest rejects artifact path with traversal", async () => {
    env = await createTestEnv();
    const dir = join(env.root, "bad-lib-traversal");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "name: bad-lib",
        "version: 1.0.0",
        "type: library",
        "artifacts:",
        "  - path: ../../../etc/passwd",
      ].join("\n")
    );

    await expect(readManifest(dir)).rejects.toThrow("cannot contain '..'");
    await env.cleanup();
  });

  test("readManifest rejects absolute artifact path", async () => {
    env = await createTestEnv();
    const dir = join(env.root, "bad-lib-abs");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "name: bad-lib",
        "version: 1.0.0",
        "type: library",
        "artifacts:",
        "  - path: /etc/passwd",
      ].join("\n")
    );

    await expect(readManifest(dir)).rejects.toThrow("must be relative");
    await env.cleanup();
  });

  test("readLibraryArtifacts reads per-artifact manifests", async () => {
    env = await createTestEnv();
    const lib = await createMockLibraryRepo(env.root, {
      name: "test-lib",
      artifacts: [
        { path: "skills/alpha", name: "alpha", type: "skill", version: "0.1.0" },
        { path: "skills/beta", name: "beta", type: "skill", version: "0.2.0" },
      ],
    });

    const rootManifest = await readManifest(lib.path);
    expect(rootManifest).not.toBeNull();

    const artifacts = await readLibraryArtifacts(lib.path, rootManifest!);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].manifest.name).toBe("alpha");
    expect(artifacts[0].manifest.version).toBe("0.1.0");
    expect(artifacts[0].manifest.type).toBe("skill");
    expect(artifacts[1].manifest.name).toBe("beta");
    expect(artifacts[1].manifest.version).toBe("0.2.0");
    await env.cleanup();
  });

  test("readManifest still works for existing types", async () => {
    env = await createTestEnv();
    // Test that a regular skill manifest still works
    const dir = join(env.root, "regular-skill");
    await Bun.write(
      join(dir, "arc-manifest.yaml"),
      [
        "name: my-skill",
        "version: 1.0.0",
        "type: skill",
        "capabilities:",
        "  filesystem:",
        "    read:",
        '      - "./"',
      ].join("\n")
    );

    const manifest = await readManifest(dir);
    expect(manifest).not.toBeNull();
    expect(manifest!.type).toBe("skill");
    expect(manifest!.name).toBe("my-skill");
    expect(manifest!.artifacts).toBeUndefined();
    await env.cleanup();
  });
});
