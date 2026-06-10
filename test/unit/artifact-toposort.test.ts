import { describe, expect, test } from "bun:test";
import { toposortArtifacts } from "../../src/lib/artifact-installer.js";
import type { ArcManifest, LibraryArtifactEntry } from "../../src/types.js";

/**
 * Build a minimal artifact entry+manifest pair for toposort tests.
 *
 * `deps` lists the names of OTHER artifacts in the same library this one
 * depends on. They are rendered into `depends_on.packages` exactly the way a
 * real library artifact manifest declares them (`{ name, repo }`).
 */
function artifact(name: string, deps: string[] = []): {
  entry: LibraryArtifactEntry;
  manifest: ArcManifest;
} {
  return {
    entry: { path: `artifacts/${name}` },
    manifest: {
      schema: "arc/v1",
      name,
      version: "1.0.0",
      type: "skill",
      depends_on: {
        packages: deps.map((d) => ({ name: d, repo: `the-metafactory/${d}` })),
      },
    },
  };
}

/** Assert `a` is ordered strictly before `b` in the result. */
function before(order: string[], a: string, b: string): boolean {
  return order.indexOf(a) < order.indexOf(b);
}

describe("toposortArtifacts", () => {
  test("returns artifacts unchanged when there are no dependencies", () => {
    const input = [artifact("a"), artifact("b"), artifact("c")];
    const sorted = toposortArtifacts(input);
    expect(sorted.map((s) => s.manifest.name)).toEqual(["a", "b", "c"]);
  });

  test("orders a dependency before its dependent", () => {
    // pilot depends on agent-state -> agent-state must come first
    const input = [artifact("pilot", ["agent-state"]), artifact("agent-state")];
    const order = toposortArtifacts(input).map((s) => s.manifest.name);
    expect(before(order, "agent-state", "pilot")).toBe(true);
  });

  test("resolves a transitive chain (dev -> pilot -> agent-state)", () => {
    const input = [
      artifact("dev", ["pilot"]),
      artifact("pilot", ["agent-state"]),
      artifact("agent-state"),
    ];
    const order = toposortArtifacts(input).map((s) => s.manifest.name);
    expect(before(order, "agent-state", "pilot")).toBe(true);
    expect(before(order, "pilot", "dev")).toBe(true);
  });

  test("resolves a diamond (two dependents share one root)", () => {
    // approver + release both depend on pilot; pilot depends on agent-state.
    const input = [
      artifact("release", ["pilot"]),
      artifact("approver", ["pilot"]),
      artifact("pilot", ["agent-state"]),
      artifact("agent-state"),
    ];
    const order = toposortArtifacts(input).map((s) => s.manifest.name);
    expect(before(order, "agent-state", "pilot")).toBe(true);
    expect(before(order, "pilot", "approver")).toBe(true);
    expect(before(order, "pilot", "release")).toBe(true);
  });

  test("ignores depends_on packages that are not artifacts of this library", () => {
    // 'bun' / external repos are install-time gates, not ordering constraints.
    const input = [artifact("alpha", ["some-external-tool"]), artifact("beta")];
    const order = toposortArtifacts(input).map((s) => s.manifest.name);
    expect(order.sort()).toEqual(["alpha", "beta"]);
  });

  test("throws on a direct cycle (a -> b -> a)", () => {
    const input = [artifact("a", ["b"]), artifact("b", ["a"])];
    expect(() => toposortArtifacts(input)).toThrow(/cycle/i);
  });

  test("throws on a self-cycle (a -> a)", () => {
    const input = [artifact("a", ["a"])];
    expect(() => toposortArtifacts(input)).toThrow(/cycle/i);
  });

  test("is deterministic — preserves declaration order among independent peers", () => {
    const input = [artifact("z"), artifact("y"), artifact("x")];
    const order = toposortArtifacts(input).map((s) => s.manifest.name);
    expect(order).toEqual(["z", "y", "x"]);
  });
});
