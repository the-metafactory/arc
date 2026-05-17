/**
 * JetStream resource helpers — idempotently provision streams + durable
 * consumers required by metafactory bus packages.
 *
 * Companion to `src/lib/nats.ts` (NSC user provisioning, arc#108) and the
 * broker-bootstrap gate in `src/commands/install.ts` (arc#152 / PR #153).
 * Those two ensure (a) the broker is running and (b) NATS users exist.
 * This module ensures (c) the JetStream stream + durable consumers exist
 * so subscribers can actually consume from the broker.
 *
 * Closes the gap Andreas diagnosed in the P-VERIFY handover: first-install
 * provisioning of CODE_REVIEW stream + `cortex-review-consumer-<network>-<agent>`
 * durable was operator-manual. New operators hit silent timeouts because
 * the consumer didn't exist; the publish landed on a subject no JetStream
 * subscription was watching.
 *
 * Idempotent semantics:
 *   - `ensureStream` — if stream exists with same config → no-op; missing → create
 *   - `ensureConsumer` — if consumer exists on stream → no-op; missing → create
 * Re-running is always safe.
 */

import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import type {
  JetStreamManager,
  StreamConfig,
  ConsumerConfig,
} from "@nats-io/jetstream";

/**
 * Default NATS URL used when no `NATS_URL` override is set. Matches pilot
 * and cortex defaults (`nats://127.0.0.1:4222`).
 */
export const DEFAULT_NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";

/**
 * Canonical stream name for code-review tasks. Subjects follow the IoAW
 * Broadcast grammar `local.{org}.{stack?}.tasks.code-review.{flavor}` so
 * the sage subscription `local.{org}.{stack}.tasks.code-review.>` lands
 * inside the stream filter.
 */
export const CODE_REVIEW_STREAM = "CODE_REVIEW";

/**
 * Default subjects covered by the CODE_REVIEW stream. The wildcards
 * span every operator-id, every stack, and every code-review flavor so
 * a single stream serves all multi-tenant deployments on the broker.
 *
 * `>` at the trailing position requires ≥1 segment, matching sage's
 * subscribe-side filter (see pilot `tests/bus/publish-review-request.test.ts`
 * for the corresponding subject derivation).
 */
export const CODE_REVIEW_STREAM_SUBJECTS: readonly string[] = [
  "local.*.tasks.code-review.>",
  "local.*.*.tasks.code-review.>",
];

/**
 * Discriminated result of a provisioning call. Mirrors the typed-failure
 * pattern in `src/lib/json-response.ts` so callers (CLI + tests) branch
 * on `reason` rather than parsing stderr.
 *
 * `created` vs `already_exists` distinguishes first-install from re-run;
 * operator logs surface the difference for "did I actually fix it" diagnosis.
 */
export type ProvisionResult<T> =
  | { ok: true; status: "created" | "already_exists"; value: T }
  | { ok: false; reason: "broker_unreachable"; cause: string }
  | { ok: false; reason: "stream_op_failed"; stream: string; cause: string }
  | { ok: false; reason: "consumer_op_failed"; stream: string; consumer: string; cause: string };

/**
 * Open a JetStream-enabled NATS connection. Surfaces the `broker_unreachable`
 * reason as a typed result rather than a thrown exception so callers can
 * decide between graceful-skip (install-time warning) and hard-fail (CLI
 * verb invoked deliberately by the operator).
 *
 * The connection MUST be `.close()`-d by the caller — this helper does not
 * own the lifecycle. Mirrors the pattern in pilot's `publishReviewRequested`.
 */
export async function connectJsm(url: string = DEFAULT_NATS_URL): Promise<
  | { ok: true; nc: NatsConnection; jsm: JetStreamManager }
  | { ok: false; reason: "broker_unreachable"; cause: string }
> {
  let nc: NatsConnection;
  // Hold the timeout handle so the success path clears it. Without
  // clearTimeout, non-JSON CLI invocations (which don't call process.exit
  // on success) keep the event loop alive for the full 2s window after the
  // command logically completes — Sage cycle-1 Performance finding.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    nc = await Promise.race([
      connect({ servers: url, name: "arc-jetstream-provision", reconnect: false }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("NATS connect timeout (2s)")), 2000);
      }),
    ]);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "broker_unreachable", cause };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  // JetStream manager init can fail with a connected broker — most often
  // when JetStream is disabled on the broker or the account lacks JS
  // permissions. Surface as `broker_unreachable` (broker is technically
  // reachable but the JS subsystem behaves as if it isn't) with the real
  // cause string, and close `nc` so the caller doesn't leak the socket
  // — Sage cycle-1 CodeQuality finding.
  try {
    const jsm = await jetstreamManager(nc);
    return { ok: true, nc, jsm };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    await nc.close().catch(() => { /* secondary to the JSM init failure */ });
    return { ok: false, reason: "broker_unreachable", cause: `JetStream manager init failed: ${cause}` };
  }
}

/**
 * Idempotently ensure a JetStream stream exists with the requested config.
 *
 * Resolution:
 *   1. `streams.info(name)` — exists? → status: "already_exists"
 *   2. Not found → `streams.add(config)` → status: "created"
 *   3. Anything else (RPC error, schema rejection) → typed failure
 *
 * Why not `update-or-add`. JetStream's `streams.update` requires posting the
 * full config and validates against the existing one. Subject-list narrowing
 * (rare but possible) is rejected by the broker as a destructive change.
 * We default to leave-existing-alone — the operator changes config via
 * `nats stream edit` deliberately, not via re-running provisioning.
 */
export async function ensureStream(
  jsm: JetStreamManager,
  config: Partial<StreamConfig> & { name: string; subjects: string[] },
): Promise<ProvisionResult<{ name: string; subjects: string[] }>> {
  try {
    const existing = await jsm.streams.info(config.name);
    return {
      ok: true,
      status: "already_exists",
      value: {
        name: existing.config.name,
        subjects: existing.config.subjects ?? [],
      },
    };
  } catch (err) {
    // JetStream's `info` throws on 404 with `code: 404` on the error.
    // Anything else (transport failure, auth) is a real error — surface it.
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found|404/i.test(message)) {
      return { ok: false, reason: "stream_op_failed", stream: config.name, cause: message };
    }
  }
  try {
    const created = await jsm.streams.add(config as StreamConfig);
    return {
      ok: true,
      status: "created",
      value: {
        name: created.config.name,
        subjects: created.config.subjects ?? [],
      },
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "stream_op_failed", stream: config.name, cause };
  }
}

/**
 * Idempotently ensure a durable consumer exists on the named stream.
 *
 * Durable-consumer name convention (cortex / sage): the consumer name
 * embeds the deployment context so multiple consumers on the same stream
 * don't collide. The handover documents
 * `cortex-review-consumer-<network>-<agent>` — pilot operators picking
 * sage/echo per-network land on distinct durables.
 *
 * Same resolution shape as {@link ensureStream}: info → exists, otherwise add.
 */
export async function ensureConsumer(
  jsm: JetStreamManager,
  stream: string,
  config: Partial<ConsumerConfig> & { durable_name: string },
): Promise<ProvisionResult<{ stream: string; durable: string; filter?: string }>> {
  try {
    const existing = await jsm.consumers.info(stream, config.durable_name);
    return {
      ok: true,
      status: "already_exists",
      value: {
        stream,
        durable: existing.name,
        filter: existing.config.filter_subject,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found|404/i.test(message)) {
      return {
        ok: false,
        reason: "consumer_op_failed",
        stream,
        consumer: config.durable_name,
        cause: message,
      };
    }
  }
  try {
    const created = await jsm.consumers.add(stream, config as ConsumerConfig);
    return {
      ok: true,
      status: "created",
      value: {
        stream,
        durable: created.name,
        filter: created.config.filter_subject,
      },
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "consumer_op_failed",
      stream,
      consumer: config.durable_name,
      cause,
    };
  }
}

/**
 * Derive the canonical cortex review-consumer durable name from network +
 * agent. Centralises the format so pilot's reference to
 * `cortex-review-consumer-metafactory-echo` in the P-VERIFY handover and
 * arc's provisioning landing on the same string by construction.
 *
 * Format: `cortex-review-consumer-<network>-<agent>`. Both segments must
 * satisfy the NATS subject-segment grammar (lowercase alphanumeric +
 * hyphen) to prevent broker-side rejections.
 */
export function reviewConsumerName(network: string, agent: string): string {
  return `cortex-review-consumer-${network}-${agent}`;
}
