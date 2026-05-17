/**
 * Unit tests for JetStream resource provisioning helpers.
 *
 * Uses a hand-rolled `JetStreamManager` mock — no real broker, no
 * `@nats-io/transport-node` connection. The helpers' idempotent-by-info-first
 * pattern means the test surface is just: stub `info` to throw 404 / return
 * existing, stub `add` to return created config. No network in CI.
 */

import { describe, test, expect } from "bun:test";
import type { JetStreamManager } from "@nats-io/jetstream";
import {
  ensureStream,
  ensureConsumer,
  reviewConsumerName,
  CODE_REVIEW_STREAM,
  CODE_REVIEW_STREAM_SUBJECTS,
} from "../../src/lib/jetstream.js";
import {
  provisionStreams,
  provisionConsumer,
} from "../../src/commands/jetstream.js";

/**
 * Hand-rolled JSM mock. The functions we touch are tiny — pinning the shape
 * here keeps the test file independent of `@nats-io/jetstream` minor-version
 * drift in unrelated method signatures.
 */
function mockJsm(opts: {
  streamsInfo?: (name: string) => Promise<{ config: { name: string; subjects?: string[] } }>;
  streamsAdd?: (config: { name: string; subjects: string[] }) => Promise<{ config: { name: string; subjects?: string[] } }>;
  consumersInfo?: (stream: string, durable: string) => Promise<{ name: string; config: { filter_subject?: string } }>;
  consumersAdd?: (stream: string, config: { durable_name: string; filter_subject?: string }) => Promise<{ name: string; config: { filter_subject?: string } }>;
}): JetStreamManager {
  const notFound = () => { throw new Error("stream not found (404)"); };
  return {
    streams: {
      info: opts.streamsInfo ?? notFound,
      add: opts.streamsAdd ?? (async (cfg) => ({ config: { name: cfg.name, subjects: cfg.subjects } })),
    },
    consumers: {
      info: opts.consumersInfo ?? notFound,
      add: opts.consumersAdd ?? (async (_stream, cfg) => ({ name: cfg.durable_name, config: { filter_subject: cfg.filter_subject } })),
    },
  } as unknown as JetStreamManager;
}

describe("reviewConsumerName", () => {
  test("composes the canonical cortex-review-consumer-<network>-<agent> format", () => {
    expect(reviewConsumerName("metafactory", "echo")).toBe("cortex-review-consumer-metafactory-echo");
    expect(reviewConsumerName("local", "sage")).toBe("cortex-review-consumer-local-sage");
  });
});

describe("ensureStream", () => {
  test("returns already_exists when stream is already present (idempotent re-run)", async () => {
    const jsm = mockJsm({
      streamsInfo: async (name) => ({ config: { name, subjects: ["local.*.tasks.code-review.>"] } }),
    });
    const result = await ensureStream(jsm, {
      name: "CODE_REVIEW",
      subjects: ["local.*.tasks.code-review.>"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("already_exists");
      expect(result.value.name).toBe("CODE_REVIEW");
    }
  });

  test("creates stream when info returns 404", async () => {
    let added = false;
    const jsm = mockJsm({
      streamsAdd: async (cfg) => {
        added = true;
        return { config: { name: cfg.name, subjects: cfg.subjects } };
      },
    });
    const result = await ensureStream(jsm, {
      name: "CODE_REVIEW",
      subjects: ["local.*.tasks.code-review.>"],
    });
    expect(added).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("created");
  });

  test("returns stream_op_failed on non-404 info error", async () => {
    const jsm = mockJsm({
      streamsInfo: async () => { throw new Error("auth: insufficient permissions"); },
    });
    const result = await ensureStream(jsm, { name: "X", subjects: ["a.>"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stream_op_failed");
  });

  test("returns stream_op_failed on add error", async () => {
    const jsm = mockJsm({
      streamsAdd: async () => { throw new Error("subject overlap with existing stream X"); },
    });
    const result = await ensureStream(jsm, { name: "Y", subjects: ["a.>"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stream_op_failed");
      expect(result.cause).toContain("subject overlap");
    }
  });
});

describe("ensureConsumer", () => {
  test("returns already_exists when durable is present", async () => {
    const jsm = mockJsm({
      consumersInfo: async (_stream, durable) => ({ name: durable, config: { filter_subject: "x.>" } }),
    });
    const result = await ensureConsumer(jsm, "CODE_REVIEW", { durable_name: "cortex-review-consumer-net-echo" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("already_exists");
      expect(result.value.durable).toBe("cortex-review-consumer-net-echo");
    }
  });

  test("creates durable when info returns 404", async () => {
    let added = false;
    const jsm = mockJsm({
      consumersAdd: async (_stream, cfg) => {
        added = true;
        return { name: cfg.durable_name, config: {} };
      },
    });
    const result = await ensureConsumer(jsm, "CODE_REVIEW", { durable_name: "cortex-review-consumer-net-echo" });
    expect(added).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("created");
  });

  test("returns consumer_op_failed on non-404 info error", async () => {
    const jsm = mockJsm({
      consumersInfo: async () => { throw new Error("transport: broken pipe"); },
    });
    const result = await ensureConsumer(jsm, "S", { durable_name: "d" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("consumer_op_failed");
  });
});

describe("provisionStreams orchestrator", () => {
  test("happy path: stream + per-(network, agent) consumer both created", async () => {
    const jsm = mockJsm({});
    const fakeNc = { close: async () => undefined };
    const r = await provisionStreams({
      consumer: { network: "metafactory", agent: "echo" },
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    });
    expect(r.resources).toHaveLength(2);
    expect(r.resources[0]).toMatchObject({ kind: "stream", name: CODE_REVIEW_STREAM, created: true });
    expect(r.resources[1]).toMatchObject({
      kind: "consumer",
      name: "cortex-review-consumer-metafactory-echo",
      stream: CODE_REVIEW_STREAM,
      created: true,
    });
  });

  test("idempotent re-run: both resources surface created=false", async () => {
    const jsm = mockJsm({
      streamsInfo: async (name) => ({ config: { name, subjects: [...CODE_REVIEW_STREAM_SUBJECTS] } }),
      consumersInfo: async (_s, d) => ({ name: d, config: {} }),
    });
    const fakeNc = { close: async () => undefined };
    const r = await provisionStreams({
      consumer: { network: "metafactory", agent: "echo" },
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    });
    for (const res of r.resources) expect(res.created).toBe(false);
  });

  test("no consumer when caller omits the {network, agent} pair", async () => {
    const jsm = mockJsm({});
    const fakeNc = { close: async () => undefined };
    const r = await provisionStreams({
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    });
    expect(r.resources).toHaveLength(1);
    expect(r.resources[0]?.kind).toBe("stream");
  });

  test("broker_unreachable surfaces as ArcNatsCommandError", async () => {
    await expect(provisionStreams({
      _connectJsm: async () => ({ ok: false as const, reason: "broker_unreachable", cause: "ECONNREFUSED" }),
    })).rejects.toThrow(/broker.*unreachable.*ECONNREFUSED/);
  });

  test("stream_op_failed surfaces as ArcNatsCommandError with stream name in message", async () => {
    const jsm = mockJsm({
      streamsInfo: async () => { throw new Error("auth: insufficient permissions"); },
    });
    const fakeNc = { close: async () => undefined };
    await expect(provisionStreams({
      streamName: "BROKEN",
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    })).rejects.toThrow(/BROKEN.*provisioning failed.*insufficient permissions/);
  });

  test("closes the NATS connection even when provisioning fails", async () => {
    let closed = false;
    const fakeNc = { close: async () => { closed = true; } };
    const jsm = mockJsm({
      streamsInfo: async () => { throw new Error("auth: forbidden"); },
    });
    await expect(provisionStreams({
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    })).rejects.toThrow(/forbidden/);
    expect(closed).toBe(true);
  });
});

describe("provisionConsumer orchestrator", () => {
  test("derives the canonical durable name from (network, agent)", async () => {
    let capturedDurable = "";
    const jsm = mockJsm({
      consumersAdd: async (_s, cfg) => {
        capturedDurable = cfg.durable_name;
        return { name: cfg.durable_name, config: {} };
      },
    });
    const fakeNc = { close: async () => undefined };
    const r = await provisionConsumer({
      network: "metafactory",
      agent: "echo",
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    });
    expect(capturedDurable).toBe("cortex-review-consumer-metafactory-echo");
    expect(r.resource.name).toBe("cortex-review-consumer-metafactory-echo");
    expect(r.resource.stream).toBe(CODE_REVIEW_STREAM);
  });

  test("optional filter-subject flows through to consumer config", async () => {
    let captured: { durable_name: string; filter_subject?: string } | null = null;
    const jsm = mockJsm({
      consumersAdd: async (_s, cfg) => {
        captured = cfg;
        return { name: cfg.durable_name, config: { filter_subject: cfg.filter_subject } };
      },
    });
    const fakeNc = { close: async () => undefined };
    await provisionConsumer({
      network: "net-a",
      agent: "echo",
      filterSubject: "local.*.tasks.code-review.typescript",
      _connectJsm: async () => ({ ok: true as const, nc: fakeNc as any, jsm }),
    });
    expect(captured!.filter_subject).toBe("local.*.tasks.code-review.typescript");
  });
});
