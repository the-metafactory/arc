import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_NATS_URL,
  ensureBroker,
  parseNatsUrl,
  requireBrokerForManifest,
  __setSpawnRunnerForTests,
  __setProbeForTests,
  __setPlatformForTests,
  type SpawnResult,
} from "../../src/lib/nats-broker.js";

/**
 * Unit tests for the NATS broker bootstrap helper (arc#152).
 *
 * Every test stubs the spawn runner, TCP probe, and platform detector so the
 * suite never actually shells out, opens a socket, or branches on the host
 * OS — pure deterministic behavior.
 */

interface SpawnCall {
  cmd: string[];
}

let spawnCalls: SpawnCall[] = [];

function stubSpawn(routes: { match: string[]; result: SpawnResult }[]) {
  spawnCalls = [];
  __setSpawnRunnerForTests((cmd) => {
    spawnCalls.push({ cmd });
    for (const route of routes) {
      if (route.match.length === cmd.length && route.match.every((m, i) => m === cmd[i])) {
        return route.result;
      }
    }
    return { exitCode: 127, stdout: "", stderr: `unmocked: ${cmd.join(" ")}` };
  });
}

beforeEach(() => {
  spawnCalls = [];
});

afterEach(() => {
  __setSpawnRunnerForTests(null);
  __setProbeForTests(null);
  __setPlatformForTests(null);
});

describe("parseNatsUrl", () => {
  test("strips nats:// prefix and parses host:port", () => {
    expect(parseNatsUrl("nats://127.0.0.1:4222")).toEqual({ host: "127.0.0.1", port: 4222 });
  });

  test("accepts bare host:port without prefix", () => {
    expect(parseNatsUrl("example.com:9999")).toEqual({ host: "example.com", port: 9999 });
  });

  test("defaults to port 4222 when omitted", () => {
    expect(parseNatsUrl("nats://example.com")).toEqual({ host: "example.com", port: 4222 });
  });

  test("falls back to default port when malformed", () => {
    expect(parseNatsUrl("nats://host:abc")).toEqual({ host: "host", port: 4222 });
  });

  test("parses auth-bearing URL — host is the actual hostname, not user:pass@host (sage cycle-2)", () => {
    // Operator-supplied URLs with embedded credentials are valid. The
    // original regex-strip + lastIndexOf parser treated `user:pass@host`
    // as the host segment, which made every auth-bearing remote broker
    // fail the probe. Pin the WHATWG-URL-backed parser's correct behaviour.
    expect(parseNatsUrl("nats://user:pass@remote.example.com:4222"))
      .toEqual({ host: "remote.example.com", port: 4222 });
  });

  test("parses auth-bearing URL without explicit port — defaults to 4222", () => {
    expect(parseNatsUrl("nats://user:pass@host.example.com"))
      .toEqual({ host: "host.example.com", port: 4222 });
  });

  test("rejects out-of-range ports — falls back to default 4222 (sage cycle-2 security)", () => {
    // `socket.connect(999999, host)` throws on most runtimes; the parser
    // must reject before reaching the probe so the structured
    // `broker_unreachable` / `bootstrap-failed` taxonomy stays intact.
    expect(parseNatsUrl("nats://host:999999")).toEqual({ host: "host", port: 4222 });
    expect(parseNatsUrl("nats://host:0")).toEqual({ host: "host", port: 4222 });
    expect(parseNatsUrl("nats://host:-1")).toEqual({ host: "host", port: 4222 });
    expect(parseNatsUrl("host:99999")).toEqual({ host: "host", port: 4222 });
  });

  test("accepts valid port boundary values", () => {
    expect(parseNatsUrl("nats://host:1")).toEqual({ host: "host", port: 1 });
    expect(parseNatsUrl("nats://host:65535")).toEqual({ host: "host", port: 65535 });
  });
});

describe("ensureBroker — broker already reachable", () => {
  test("noop when local broker reachable, no NATS_URL set", async () => {
    __setProbeForTests(async () => true);
    __setPlatformForTests(() => "darwin");
    stubSpawn([]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("already-running");
    expect(result.url).toBe(DEFAULT_NATS_URL);
    expect(result.remoteRequested).toBe(false);
    expect(spawnCalls.length).toBe(0);
  });

  test("noop when remote NATS_URL reachable", async () => {
    __setProbeForTests(async (host, port) => host === "remote.example.com" && port === 4222);
    __setPlatformForTests(() => "linux");
    stubSpawn([]);

    const result = await ensureBroker({
      env: { NATS_URL: "nats://remote.example.com:4222" },
      quiet: true,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("already-running");
    expect(result.url).toBe("nats://remote.example.com:4222");
    expect(result.remoteRequested).toBe(true);
    expect(spawnCalls.length).toBe(0);
  });
});

describe("ensureBroker — remote NATS_URL unreachable", () => {
  test("does NOT auto-bootstrap; returns clear error", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "darwin");
    stubSpawn([]);

    const result = await ensureBroker({
      env: { NATS_URL: "nats://remote.example.com:4222" },
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("remote-unreachable");
    expect(result.remoteRequested).toBe(true);
    expect(result.message).toContain("NATS_URL=nats://remote.example.com:4222");
    expect(result.message).toContain("will not auto-bootstrap");
    expect(spawnCalls.length).toBe(0);
  });
});

describe("ensureBroker — darwin bootstrap path", () => {
  test("brew install + brew services start when local broker missing", async () => {
    // Stateful probe: first call (initial reachability) → false → triggers
    // bootstrap. Subsequent calls (post-`brew services start` readiness
    // re-probe added in sage cycle-2) → true → confirms the broker came up.
    let probeCalls = 0;
    __setProbeForTests(async () => {
      probeCalls++;
      return probeCalls > 1;
    });
    __setPlatformForTests(() => "darwin");
    stubSpawn([
      { match: ["which", "brew"], result: { exitCode: 0, stdout: "/opt/homebrew/bin/brew", stderr: "" } },
      { match: ["brew", "install", "nats-server"], result: { exitCode: 0, stdout: "installed", stderr: "" } },
      { match: ["brew", "services", "start", "nats-server"], result: { exitCode: 0, stdout: "started", stderr: "" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("bootstrapped");
    expect(result.remoteRequested).toBe(false);
    expect(result.message).toContain("brew services");
    expect(spawnCalls.map((c) => c.cmd.join(" "))).toEqual([
      "which brew",
      "brew install nats-server",
      "brew services start nats-server",
    ]);
  });

  test("fails fast when Homebrew is missing", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "darwin");
    stubSpawn([
      { match: ["which", "brew"], result: { exitCode: 1, stdout: "", stderr: "" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("Homebrew not found");
  });

  test("propagates brew install failure", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "darwin");
    stubSpawn([
      { match: ["which", "brew"], result: { exitCode: 0, stdout: "/opt/homebrew/bin/brew", stderr: "" } },
      { match: ["brew", "install", "nats-server"], result: { exitCode: 1, stdout: "", stderr: "Network error fetching formula" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("brew install nats-server failed");
    expect(result.message).toContain("Network error");
  });

  test("propagates brew services start failure with retry hint", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "darwin");
    stubSpawn([
      { match: ["which", "brew"], result: { exitCode: 0, stdout: "/opt/homebrew/bin/brew", stderr: "" } },
      { match: ["brew", "install", "nats-server"], result: { exitCode: 0, stdout: "", stderr: "" } },
      { match: ["brew", "services", "start", "nats-server"], result: { exitCode: 1, stdout: "", stderr: "launchctl bootstrap failed" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("brew services start nats-server failed");
    expect(result.message).toContain("Retry manually");
  });
});

describe("ensureBroker — linux bootstrap path", () => {
  test("systemctl --user enable --now succeeds", async () => {
    // Stateful probe: same shape as the darwin success test — first call
    // false (triggers bootstrap), subsequent true (post-systemctl readiness
    // re-probe added in sage cycle-2).
    let probeCalls = 0;
    __setProbeForTests(async () => {
      probeCalls++;
      return probeCalls > 1;
    });
    __setPlatformForTests(() => "linux");
    stubSpawn([
      { match: ["which", "systemctl"], result: { exitCode: 0, stdout: "/usr/bin/systemctl", stderr: "" } },
      { match: ["which", "nats-server"], result: { exitCode: 0, stdout: "/usr/local/bin/nats-server", stderr: "" } },
      { match: ["systemctl", "--user", "enable", "--now", "nats-server.service"], result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("bootstrapped");
    expect(result.message).toContain("systemd");
  });

  test("fails clearly when systemctl is missing", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "linux");
    stubSpawn([
      { match: ["which", "systemctl"], result: { exitCode: 1, stdout: "", stderr: "" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("requires systemctl");
  });

  test("fails clearly when nats-server binary is missing", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "linux");
    stubSpawn([
      { match: ["which", "systemctl"], result: { exitCode: 0, stdout: "/usr/bin/systemctl", stderr: "" } },
      { match: ["which", "nats-server"], result: { exitCode: 1, stdout: "", stderr: "" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("nats-server binary not found");
  });

  test("propagates systemctl enable failure", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "linux");
    stubSpawn([
      { match: ["which", "systemctl"], result: { exitCode: 0, stdout: "/usr/bin/systemctl", stderr: "" } },
      { match: ["which", "nats-server"], result: { exitCode: 0, stdout: "/usr/local/bin/nats-server", stderr: "" } },
      { match: ["systemctl", "--user", "enable", "--now", "nats-server.service"], result: { exitCode: 1, stdout: "", stderr: "Unit nats-server.service not found." } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("Unit nats-server.service not found");
  });
});

describe("ensureBroker — unsupported platform", () => {
  test("returns unsupported-platform on windows", async () => {
    __setProbeForTests(async () => false);
    __setPlatformForTests(() => "win32");
    stubSpawn([]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unsupported-platform");
    expect(result.message).toContain("win32");
  });
});

describe("ensureBroker — idempotency", () => {
  test("post-bootstrap readiness re-probe — never reaches success → bootstrap-failed (sage cycle-2)", async () => {
    // `brew services start` exits 0 but launchd takes time to spin up the
    // process — sage cycle-1 important finding. Pin the new behaviour:
    // when every readiness probe after the start command times out, the
    // helper returns `bootstrap-failed` with the manual recovery command,
    // not a misleading `bootstrapped` success.
    __setProbeForTests(async () => false); // initial false + every retry false
    __setPlatformForTests(() => "darwin");
    stubSpawn([
      { match: ["which", "brew"], result: { exitCode: 0, stdout: "/opt/homebrew/bin/brew", stderr: "" } },
      { match: ["brew", "install", "nats-server"], result: { exitCode: 0, stdout: "", stderr: "" } },
      { match: ["brew", "services", "start", "nats-server"], result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);

    const result = await ensureBroker({ env: {}, quiet: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("bootstrap-failed");
    expect(result.message).toContain("did not become reachable");
    expect(result.message).toContain("retry manually: brew services start nats-server");
  });

  test("second call against a now-running broker is a noop", async () => {
    __setPlatformForTests(() => "darwin");

    // First call: not reachable on the first probe (triggers bootstrap),
    // reachable on subsequent probes (post-bootstrap readiness check added
    // in sage cycle-2). Switching to `true` permanently after the initial
    // probe also covers the idempotent second call below.
    let probeCalls = 0;
    __setProbeForTests(async () => {
      probeCalls++;
      return probeCalls > 1;
    });
    stubSpawn([
      { match: ["which", "brew"], result: { exitCode: 0, stdout: "/opt/homebrew/bin/brew", stderr: "" } },
      { match: ["brew", "install", "nats-server"], result: { exitCode: 0, stdout: "", stderr: "" } },
      { match: ["brew", "services", "start", "nats-server"], result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const first = await ensureBroker({ env: {}, quiet: true });
    expect(first.status).toBe("bootstrapped");

    // After bootstrap, broker is up; second call must not spawn anything
    // (probe still returns true from the stateful counter set above).
    spawnCalls = [];
    const second = await ensureBroker({ env: {}, quiet: true });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("already-running");
    expect(spawnCalls.length).toBe(0);
  });
});

describe("requireBrokerForManifest — shared install/upgrade gate (sage cycle-2)", () => {
  test("manifest without requires.nats → ok:true without probing", async () => {
    // Pin that the gate short-circuits BEFORE probe — important because
    // install paths call this on every package, most of which don't need
    // a broker. Counted probe stub confirms zero calls.
    let probeCalls = 0;
    __setProbeForTests(async () => {
      probeCalls++;
      return true;
    });
    const result = await requireBrokerForManifest({ name: "no-bus-pkg" });
    expect(result.ok).toBe(true);
    expect(probeCalls).toBe(0);
  });

  test("manifest with requires.nats=true + reachable broker → ok:true", async () => {
    __setProbeForTests(async () => true);
    const result = await requireBrokerForManifest(
      { name: "bus-pkg", requires: { nats: true } },
      { quiet: true },
    );
    expect(result.ok).toBe(true);
  });

  test("manifest with requires.nats + unreachable + NATS_URL set → ok:false carrying formatted error", async () => {
    __setProbeForTests(async () => false);
    process.env.NATS_URL = "nats://nonexistent.test:4222";
    try {
      const result = await requireBrokerForManifest(
        { name: "bus-pkg", requires: { nats: true } },
        { quiet: true, noun: "Artifact", contextClause: " during upgrade" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The formatted error composes the noun + name + clause + raw
        // ensureBroker message — the exact shape callers (install /
        // upgrade) used to construct inline.
        expect(result.error).toContain("Artifact 'bus-pkg' requires a running NATS broker");
        expect(result.error).toContain("during upgrade");
        expect(result.error).toContain("NATS_URL=nats://nonexistent.test:4222");
      }
    } finally {
      delete process.env.NATS_URL;
    }
  });
});
