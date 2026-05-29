/**
 * Stable JSON response contract for `arc nats *` commands (arc#131).
 *
 * Cortex (and any other shell-out consumer) relies on this schema being a
 * versioned, breaking-change-controlled surface. See
 * `docs/integrations/cortex-creds.md` for the integration guide.
 *
 * Schema version: `arc.nats.v1`
 *
 * - On success: `{ schema, ok: true, ...command-specific fields }`
 * - On failure: `{ schema, ok: false, error: { code, message } }`
 *
 * Exit code is `0` for `ok: true`, non-zero for `ok: false`.
 */

export const ARC_NATS_SCHEMA = "arc.nats.v1" as const;

/**
 * Closed set of error codes emitted by `arc nats --json`. Cortex (and any
 * other consumer) can branch on these without parsing human-readable text.
 *
 * If a new code is needed, it MUST be added here and documented in
 * `docs/integrations/cortex-creds.md` before being emitted.
 */
export type ArcNatsErrorCode =
  | "NSC_NOT_INSTALLED"     // `nsc` binary missing on PATH
  | "NSC_COMMAND_FAILED"    // `nsc <subcommand>` exited non-zero (generic shell-out failure)
  | "USER_NOT_FOUND"        // bot user does not exist under the account
  | "ACCOUNT_NOT_FOUND"     // operator account cannot be detected/resolved
  | "ALREADY_EXISTS"        // user / creds file already exists (no --force)
  | "PUSH_FAILED"           // server-side revoke push (`nsc push`) failed
  | "REVOKE_FAILED"         // `nsc revocations add-user` failed
  | "VALIDATION_ERROR"      // bot name, subject, flags failed validation
  | "INVALID_USER_KEY"      // `nsc describe user -J` returned malformed data
  | "ROLLBACK_FAILED"       // create/reissue failed mid-way; manual recovery
  | "BROKER_UNREACHABLE"    // JetStream provisioning: NATS broker not reachable
  | "STREAM_OP_FAILED"      // JetStream provisioning: stream info/add/update failed
  | "CONSUMER_OP_FAILED"    // JetStream provisioning: consumer info/add failed
  | "UNKNOWN";              // catch-all for un-mapped failures

export interface ArcNatsError {
  code: ArcNatsErrorCode;
  message: string;
}

/**
 * Domain exception raised by `arc nats *` command implementations. The CLI
 * layer catches these, formats them as either human-readable stderr or as
 * a structured `--json` error envelope.
 */
export class ArcNatsCommandError extends Error {
  readonly code: ArcNatsErrorCode;
  constructor(code: ArcNatsErrorCode, message: string) {
    super(message);
    this.name = "ArcNatsCommandError";
    this.code = code;
  }
}

export interface JsonOkBase {
  schema: typeof ARC_NATS_SCHEMA;
  ok: true;
}

export interface JsonError {
  schema: typeof ARC_NATS_SCHEMA;
  ok: false;
  error: ArcNatsError;
}

/** Per-command success shapes. Each shape is part of the public contract. */

export interface AddBotJson extends JsonOkBase {
  bot: string;
  account: string;
  credsPath: string;
  /** Raw user JWT (the `BEGIN NATS USER JWT` block, base64 body only). */
  jwt: string;
  /** U-prefixed NKey public key (the `sub` claim of the user JWT). */
  pubKey: string;
}

export interface ReissueBotJson extends JsonOkBase {
  bot: string;
  account: string;
  credsPath: string;
  /** The new user pubkey after re-creation. */
  newPubKey: string;
  /** The OLD user pubkey that was revoked + pushed (arc#132 surface). */
  revokedPubKey: string;
}

export interface RemoveBotJson extends JsonOkBase {
  bot: string;
  account: string;
  /** The user pubkey that was revoked + pushed to the bus. */
  revokedPubKey: string;
  /** True iff the creds file was deleted (reflects --delete-creds outcome). */
  credsFileDeleted: boolean;
}

export interface SetupOperatorBotResult {
  bot: string;
  ok: boolean;
  credsPath?: string;
  pubKey?: string;
  error?: ArcNatsError;
}

export interface SetupOperatorJson extends JsonOkBase {
  account: string;
  bots: SetupOperatorBotResult[];
  summary: {
    total: number;
    ok: number;
    failed: number;
  };
}

/**
 * `arc nats provision-streams` / `arc nats provision-consumer` result.
 *
 * `created` distinguishes first-install from re-run idempotent no-op.
 * Multiple resources may be touched in a single call (one stream + N
 * consumers), so `resources` is a list rather than a single field.
 */
export interface ProvisionJson extends JsonOkBase {
  /** Each touched resource, in invocation order. */
  resources: {
    kind: "stream" | "consumer";
    name: string;
    /** Parent stream for consumers; omitted for streams. */
    stream?: string;
    /** `true` iff this call created the resource; `false` for idempotent no-op. */
    created: boolean;
  }[];
  /** NATS server URL the provisioning targeted. */
  natsUrl: string;
}

/**
 * Emit a single line of JSON to stdout and return. Caller is responsible for
 * setting the process exit code (0 for ok, 1 for !ok).
 *
 * Signature is the documented envelope union so a wrong-shaped payload is a
 * compile error, not a silent contract violation.
 */
export function emitJson(
  payload: AddBotJson | ReissueBotJson | RemoveBotJson | SetupOperatorJson | ProvisionJson | JsonError,
): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/**
 * Extract a stable `ArcNatsErrorCode` from an arbitrary error caught at the
 * CLI boundary. Falls back to "UNKNOWN" for unrecognised shapes.
 */
export function classifyError(err: unknown): ArcNatsError {
  if (err instanceof ArcNatsCommandError) {
    return { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "UNKNOWN", message };
}
