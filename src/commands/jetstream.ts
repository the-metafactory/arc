/**
 * arc nats provision-streams / provision-consumer — JetStream resource
 * provisioning commands.
 *
 * Companion to `arc nats add-bot` (NSC user provisioning, arc#108) and the
 * broker-bootstrap gate in `install.ts` (arc#152 / PR #153). Together
 * those three layers make a fresh-operator install reach a state where
 * `pilot request-review` round-trips to sage without any manual NATS
 * admin work.
 *
 * Use cases:
 *   - First-install: run after broker comes up to create CODE_REVIEW + per-agent durables
 *   - Re-run / diagnosis: idempotent — safe to invoke on a healthy host
 *   - CI: stand up a test broker, provision, run integration tests, tear down
 */

import {
  connectJsm,
  ensureStream,
  ensureConsumer,
  reviewConsumerName,
  CODE_REVIEW_STREAM,
  CODE_REVIEW_STREAM_SUBJECTS,
  DEFAULT_NATS_URL,
} from "../lib/jetstream.js";
import type { JetStreamManager } from "@nats-io/jetstream";
import { ArcNatsCommandError, type ArcNatsErrorCode } from "../lib/json-response.js";

/**
 * Map a JetStream `ProvisionResult` failure reason to the public
 * `ArcNatsErrorCode` taxonomy. Keep this isolated so the CLI layer's
 * `classifyError` doesn't depend on JetStream-internal types.
 */
function reasonToCode(
  reason: "broker_unreachable" | "stream_op_failed" | "consumer_op_failed",
): ArcNatsErrorCode {
  switch (reason) {
    case "broker_unreachable": return "BROKER_UNREACHABLE";
    case "stream_op_failed":   return "STREAM_OP_FAILED";
    case "consumer_op_failed": return "CONSUMER_OP_FAILED";
  }
}

/**
 * Touched-resource entry surfaced in both human-readable stderr and the
 * `--json` envelope. `created: false` is a successful idempotent no-op.
 */
export interface ResourceOutcome {
  kind: "stream" | "consumer";
  name: string;
  stream?: string;
  created: boolean;
}

export interface ProvisionStreamsOpts {
  /** NATS broker URL. Defaults to {@link DEFAULT_NATS_URL}. */
  natsUrl?: string;
  /** Override the stream name. Defaults to {@link CODE_REVIEW_STREAM}. */
  streamName?: string;
  /** Override the subject pattern list. Defaults to {@link CODE_REVIEW_STREAM_SUBJECTS}. */
  subjects?: readonly string[];
  /** When true, `addPerNetworkConsumer` is also invoked for the given (network, agent) pair. */
  consumer?: { network: string; agent: string };
  /** Test seam — injectable JSM connector. */
  _connectJsm?: typeof connectJsm;
}

/**
 * Provision the CODE_REVIEW stream and optionally a per-(network, agent)
 * durable consumer in one call.
 *
 * Throws `ArcNatsCommandError` on any failure so the CLI layer's existing
 * `try/catch` → `classifyError` path applies uniformly to nats subcommands.
 */
export async function provisionStreams(opts: ProvisionStreamsOpts = {}): Promise<{
  resources: ResourceOutcome[];
  natsUrl: string;
}> {
  const natsUrl = opts.natsUrl ?? DEFAULT_NATS_URL;
  const streamName = opts.streamName ?? CODE_REVIEW_STREAM;
  const subjects = [...(opts.subjects ?? CODE_REVIEW_STREAM_SUBJECTS)];
  const doConnect = opts._connectJsm ?? connectJsm;

  const connection = await doConnect(natsUrl);
  if (!connection.ok) {
    throw new ArcNatsCommandError(
      reasonToCode(connection.reason),
      `JetStream provisioning failed: broker at ${natsUrl} unreachable (${connection.cause}). ` +
        `If you haven't started the broker yet, see arc#152 / PR#153. ` +
        `If the broker is up, check $NATS_URL and the JetStream account permissions.`,
    );
  }

  const { nc, jsm } = connection;
  const resources: ResourceOutcome[] = [];

  try {
    const streamResult = await ensureStream(jsm, { name: streamName, subjects });
    if (!streamResult.ok) {
      throw new ArcNatsCommandError(
        reasonToCode(streamResult.reason),
        `Stream "${streamName}" provisioning failed: ${streamResult.cause}`,
      );
    }
    resources.push({
      kind: "stream",
      name: streamResult.value.name,
      created: streamResult.status === "created",
    });

    if (opts.consumer) {
      const consumerOutcome = await provisionConsumerInternal(
        jsm,
        streamName,
        opts.consumer.network,
        opts.consumer.agent,
      );
      resources.push(consumerOutcome);
    }
  } finally {
    await nc.close().catch(() => {
      /* close failure is secondary to provisioning result */
    });
  }

  return { resources, natsUrl };
}

export interface ProvisionConsumerOpts {
  /** NATS broker URL. */
  natsUrl?: string;
  /** Stream the durable consumer attaches to. Defaults to CODE_REVIEW. */
  stream?: string;
  /** Network segment of the consumer name (`cortex-review-consumer-<network>-<agent>`). */
  network: string;
  /** Agent segment of the consumer name. */
  agent: string;
  /** Optional filter subject override. */
  filterSubject?: string;
  /** Test seam — injectable JSM connector. */
  _connectJsm?: typeof connectJsm;
}

/**
 * Provision a single per-(network, agent) durable consumer on an existing
 * stream. Errors if the stream does not exist (call `provisionStreams` first).
 */
export async function provisionConsumer(opts: ProvisionConsumerOpts): Promise<{
  resource: ResourceOutcome;
  natsUrl: string;
}> {
  const natsUrl = opts.natsUrl ?? DEFAULT_NATS_URL;
  const stream = opts.stream ?? CODE_REVIEW_STREAM;
  const doConnect = opts._connectJsm ?? connectJsm;

  const connection = await doConnect(natsUrl);
  if (!connection.ok) {
    throw new ArcNatsCommandError(
      reasonToCode(connection.reason),
      `Consumer provisioning failed: broker at ${natsUrl} unreachable (${connection.cause}).`,
    );
  }

  const { nc, jsm } = connection;
  try {
    const outcome = await provisionConsumerInternal(
      jsm,
      stream,
      opts.network,
      opts.agent,
      opts.filterSubject,
    );
    return { resource: outcome, natsUrl };
  } finally {
    await nc.close().catch(() => {
      /* close failure is secondary */
    });
  }
}

/**
 * Internal helper — shared by `provisionStreams({consumer})` and standalone
 * `provisionConsumer`. Centralises the durable-name derivation + the
 * `ensureConsumer` → typed-error mapping.
 */
async function provisionConsumerInternal(
  jsm: JetStreamManager,
  stream: string,
  network: string,
  agent: string,
  filterSubject?: string,
): Promise<ResourceOutcome> {
  const durable = reviewConsumerName(network, agent);
  const result = await ensureConsumer(jsm, stream, {
    durable_name: durable,
    ...(filterSubject !== undefined && { filter_subject: filterSubject }),
    ack_policy: "explicit" as ConsumerAckPolicy,
  });
  if (!result.ok) {
    throw new ArcNatsCommandError(
      reasonToCode(result.reason),
      `Consumer "${durable}" on stream "${stream}" provisioning failed: ${result.cause}`,
    );
  }
  return {
    kind: "consumer",
    name: result.value.durable,
    stream: result.value.stream,
    created: result.status === "created",
  };
}

/**
 * Re-export of JetStream's `AckPolicy` enum value as a string literal so
 * the orchestrator stays one import-of-the-lib lighter. The wire format is
 * the bare string ("explicit") — using the runtime enum would force every
 * caller to import the same dependency.
 */
type ConsumerAckPolicy = "explicit";
