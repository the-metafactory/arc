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
 *
 * Schema version: `arc.nats.federation.v1`
 * Used by `arc nats add-federation-export` — a separate schema namespace
 * keeps federation commands cleanly separated from user-management commands
 * and avoids confusing arc.nats.v1 consumers that guard on ARC_NATS_SCHEMA.
 */

export const ARC_NATS_SCHEMA = "arc.nats.v1" as const;

/** Schema string for federation-related commands (add-federation-export). */
export const ARC_NATS_FEDERATION_SCHEMA = "arc.nats.federation.v1" as const;

/**
 * Schema string for operator-topology commands (init-operator, add-account).
 *
 * A separate schema namespace (arc#252) keeps the sovereign-operator primitives
 * cleanly separated from the user-management (`arc.nats.v1`) and federation
 * (`arc.nats.federation.v1`) surfaces, so consumers that guard on a specific
 * `schema` are unaffected when these commands evolve.
 */
export const ARC_NATS_OPERATOR_SCHEMA = "arc.nats.operator.v1" as const;

/**
 * Schema string for the federated-user mint (`arc nats add-federated-user`,
 * cortex#1598). Its own namespace (the `arc.nats.federation.v1` precedent):
 * the federated-user FAMILY of verbs (add / reissue / revoke) all emit this
 * schema, and the consumer guards on exactly this string.
 *
 * NOTE — field presence VARIES within this schema version by verb: `add`
 * (`AddFederatedUserJson`) and `reissue` (`ReissueFederatedUserJson`) carry
 * creds + pubkeys; `revoke` (`RevokeFederatedUserJson`) is a strict subset
 * (account/user/revokedPubKey only). A consumer must dispatch on WHICH verb it
 * invoked, not on the schema string alone, to know which fields to expect — the
 * cortex adapter does exactly that (one port method per verb).
 */
export const ARC_NATS_FEDERATED_USER_SCHEMA = "arc.nats.federated-user.v1" as const;

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
  | "OPERATOR_NOT_FOUND"    // nsc operator cannot be detected/resolved (export-operator)
  | "SYSTEM_ACCOUNT_NOT_FOUND" // the operator's SYS account does not exist (export-system)
  | "ALREADY_EXISTS"        // user / creds file already exists (no --force)
  | "PUSH_FAILED"           // server-side revoke push (`nsc push`) failed
  | "REVOKE_FAILED"         // `nsc revocations add-user` failed
  | "VALIDATION_ERROR"      // bot name, subject, flags failed validation
  | "INVALID_USER_KEY"      // `nsc describe user -J` returned malformed data
  | "ROLLBACK_FAILED"       // create/reissue failed mid-way; manual recovery
  | "BROKER_UNREACHABLE"    // JetStream provisioning: NATS broker not reachable
  | "STREAM_OP_FAILED"      // JetStream provisioning: stream info/add/update failed
  | "CONSUMER_OP_FAILED"    // JetStream provisioning: consumer info/add failed
  | "SIGNING_KEY_FAILED"    // scoped signing key create/verify failed (add-federated-user)
  | "USER_NOT_SCOPED"       // existing user is NOT signed by the scoped key — refuse to export
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

export interface JsonFederationOkBase {
  schema: typeof ARC_NATS_FEDERATION_SCHEMA;
  ok: true;
}

export interface JsonOperatorOkBase {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: true;
}

export interface JsonError {
  schema: typeof ARC_NATS_SCHEMA;
  ok: false;
  error: ArcNatsError;
}

export interface JsonFederationError {
  schema: typeof ARC_NATS_FEDERATION_SCHEMA;
  ok: false;
  error: ArcNatsError;
}

export interface JsonOperatorError {
  schema: typeof ARC_NATS_OPERATOR_SCHEMA;
  ok: false;
  error: ArcNatsError;
}

export interface JsonFederatedUserOkBase {
  schema: typeof ARC_NATS_FEDERATED_USER_SCHEMA;
  ok: true;
}

export interface JsonFederatedUserError {
  schema: typeof ARC_NATS_FEDERATED_USER_SCHEMA;
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
 * `arc nats add-federation-export` result (schema: arc.nats.federation.v1).
 *
 * `exportAlreadyPresent` / `importAlreadyPresent` distinguish first-run
 * mutations from idempotent no-ops so the orchestrator can log what changed.
 *
 * `pushResult` surfaces per-account push outcomes. Both accounts are always
 * pushed even if the export/import already existed (nsc push is idempotent).
 */
export interface AddFederationExportJson extends JsonFederationOkBase {
  fromAccount: string;
  toAccount: string;
  subject: string;
  /** True iff a new export was added to fromAccount (false = already present). */
  exportAdded: boolean;
  /** True iff a new import was added to toAccount (false = already present). */
  importAdded: boolean;
  exportAlreadyPresent: boolean;
  importAlreadyPresent: boolean;
  /**
   * Push outcome per account.
   * - `{ fromAccount: "ok", toAccount: "ok" }` when --apply executed pushes.
   * - `{ fromAccount: "skipped", toAccount: "skipped" }` in dry-run (apply=false).
   * - `undefined` only when the command short-circuits with no nsc calls
   *   (e.g. fromAccount === toAccount — Case A same-account no-op).
   */
  pushResult?: {
    fromAccount: "ok" | "skipped";
    toAccount: "ok" | "skipped";
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
 * `arc nats init-operator` result (schema: arc.nats.operator.v1).
 *
 * `created` distinguishes a first-time create from an idempotent no-op:
 *   - `created: true`  → `nsc add operator` ran (fresh create, or `--force` recreate).
 *   - `created: false` → the operator already existed and was left untouched.
 *
 * `seedPath` is the nsc keystore path of the operator identity seed (mode 0o600,
 * managed by nsc). `null` when the seed file could not be located on disk
 * (e.g. a non-default keystore layout) — the operator was still created.
 */
export interface InitOperatorJson extends JsonOperatorOkBase {
  operator: string;
  /** O-prefixed operator NKey public key. */
  pubKey: string;
  /** True iff `nsc add operator` ran this invocation. */
  created: boolean;
  /** True iff the operator already existed before this invocation. */
  alreadyExisted: boolean;
  /** Keystore path of the operator seed (mode 0o600), or null if not located. */
  seedPath: string | null;
}

/**
 * `arc nats add-account` result (schema: arc.nats.operator.v1).
 *
 * Idempotent: `created` is `false` on a re-run for an account that already
 * exists. Used for BOTH the federation account and a per-stack agents account
 * (ADR-0012 isolation), so it is callable repeatedly with different names.
 */
export interface AddAccountJson extends JsonOperatorOkBase {
  account: string;
  /** A-prefixed account NKey public key. */
  pubKey: string;
  /** True iff `nsc add account` ran this invocation. */
  created: boolean;
  /** True iff the account already existed before this invocation. */
  alreadyExisted: boolean;
}

/**
 * `arc nats export-account` result (schema: arc.nats.operator.v1).
 *
 * Read-only companion to `add-account` (cortex#1257 / make-live). Surfaces the
 * material `cortex network make-live` needs to land a stack's daemon onto its own
 * account WITHOUT cortex ever running nsc:
 *   - `jwt`     — the account JWT, dropped into the nats-server `resolver_preload`
 *                 (MEMORY resolver) so the server learns the account.
 *   - `seedPath`— the keystore path of the account's identity seed (SA-prefixed,
 *                 mode 0o600), for the deferred TrustResolver signing-key rewrite.
 *                 `null` when the seed file is not on disk (non-default keystore).
 */
export interface ExportAccountJson extends JsonOperatorOkBase {
  account: string;
  /** A-prefixed account NKey public key. */
  pubKey: string;
  /** The account JWT (`eyJ…`) — preload into `resolver_preload`. */
  jwt: string;
  /** Keystore path of the account identity seed (mode 0o600), or null if absent. */
  seedPath: string | null;
}

/**
 * `arc nats export-operator` result (schema: arc.nats.operator.v1).
 *
 * Read-only sibling of `export-account` (cortex#1265 / server-config bridge).
 * Surfaces the operator JWT `cortex network provision` populates into
 * `stack.nats_infra.operator_jwt` so `cortex network join` (and make-live
 * bootstrap) can render the operator-mode `.conf` WITHOUT cortex ever running
 * nsc:
 *   - `jwt`     — the operator JWT, emitted as the `operator:` block.
 *   - `seedPath`— the keystore path of the operator identity seed (O-prefixed,
 *                 mode 0o600). `null` when the seed file is not on disk.
 */
export interface ExportOperatorJson extends JsonOperatorOkBase {
  operator: string;
  /** O-prefixed operator NKey public key. */
  pubKey: string;
  /** The operator JWT (`eyJ…`) — emitted as the `operator:` block. */
  jwt: string;
  /** Keystore path of the operator seed (mode 0o600), or null if absent. */
  seedPath: string | null;
}

/**
 * `arc nats export-system` result (schema: arc.nats.operator.v1).
 *
 * Read-only sibling of `export-account` (cortex#1265 / server-config bridge).
 * Surfaces the operator's SYS account pubkey + JWT `cortex network provision`
 * populates into `stack.nats_infra.{system_account, system_account_jwt}` so the
 * rendered operator-mode `.conf` can set `system_account` + preload its JWT —
 * still WITHOUT cortex running nsc. The SYS account is OPTIONAL (an operator-mode
 * bus runs without one), so callers treat SYSTEM_ACCOUNT_NOT_FOUND as a skip.
 */
export interface ExportSystemJson extends JsonOperatorOkBase {
  /** The system-account name (default "SYS"). */
  account: string;
  /** A-prefixed account NKey public key. */
  pubKey: string;
  /** The SYS account JWT (`eyJ…`) — preload alongside `system_account`. */
  jwt: string;
  /** Keystore path of the account identity seed (mode 0o600), or null if absent. */
  seedPath: string | null;
}

/**
 * `arc nats add-federated-user` result (schema: arc.nats.federated-user.v1;
 * cortex#1598). Mints a hub-transport user whose permissions come ENTIRELY
 * from the account's `federated`-role scoped signing key (subject-templated —
 * the user itself carries no permissions). Both halves are idempotent:
 *
 *   - `scopeCreated` / `scopeAlreadyPresent` — the scoped signing key is
 *     created once per account and never silently rewritten.
 *   - `userCreated` / `userAlreadyPresent` — an existing user signed by the
 *     scoped key is re-exported and reported present; an existing user signed
 *     by anything else is REFUSED (`USER_NOT_SCOPED`) — re-exporting it would
 *     hand out an unscoped credential.
 *
 * `subTemplate` / `pubTemplate` report the scope the credential is bound to —
 * VERIFIED, not assumed: the command reads the scope's live templates from the
 * account claims and refuses the mint (`SIGNING_KEY_FAILED`) when a
 * pre-existing role key diverges from these values, so a reported template is
 * always the store's actual template.
 */
export interface AddFederatedUserJson extends JsonFederatedUserOkBase {
  account: string;
  /** A-prefixed account NKey public key. */
  accountPubKey: string;
  /** The minted user name (`<principal>.<stack>` dotted convention). */
  user: string;
  /** U-prefixed user NKey public key (the `sub` claim). */
  userPubKey: string;
  /** A-prefixed pubkey of the `federated`-role scoped signing key that signed the user. */
  signingKeyPubKey: string;
  scopeCreated: boolean;
  scopeAlreadyPresent: boolean;
  userCreated: boolean;
  userAlreadyPresent: boolean;
  credsPath: string;
  /** Raw user JWT (the `BEGIN NATS USER JWT` block, base64 body only). */
  jwt: string;
  /** The scope's subscribe template (own-scope only). */
  subTemplate: string;
  /** The scope's publish template (the cross-principal wire grammar). */
  pubTemplate: string;
}

/**
 * `arc nats reissue-federated-user` result (schema: arc.nats.federated-user.v1;
 * cortex#1599 rotate). Revokes the OLD user server-side (revocations add-user +
 * push — a runtime cut, no hub restart), then re-mints FRESH material under the
 * SAME `federated`-role scoped signing key (no own perms) and exports its creds.
 * Same schema family as add-federated-user; the extra `revokedPubKey`/`newPubKey`
 * name the two keys the rotation swapped.
 */
export interface ReissueFederatedUserJson extends JsonFederatedUserOkBase {
  account: string;
  /** A-prefixed account NKey public key. */
  accountPubKey: string;
  user: string;
  /** U-prefixed pubkey of the NEW (freshly-minted) user. */
  newPubKey: string;
  /** U-prefixed pubkey of the OLD user, added to the account's revocation map. */
  revokedPubKey: string;
  /** A-prefixed pubkey of the `federated`-role scoped signing key that signed the new user. */
  signingKeyPubKey: string;
  scopeAlreadyPresent: boolean;
  credsPath: string;
  /** Raw NEW user JWT. */
  jwt: string;
  subTemplate: string;
  pubTemplate: string;
}

/**
 * `arc nats revoke-federated-user` result (schema: arc.nats.federated-user.v1;
 * cortex#1599 revoke). Adds the user's pubkey to the account's revocation map
 * and pushes the updated account JWT so the server rejects the outstanding creds
 * at runtime (no hub restart), then deletes the local user. A push that reaches
 * a live resolver and FAILS surfaces `PUSH_FAILED` (the JWT stays valid — abort
 * loudly). But whether a push to a memory/preload resolver fails non-zero or
 * silently no-ops (exit 0) is resolver-dependent, so this exit code is NOT the
 * guarantee that a revoke lands — a push-capable resolver on the hub is (cortex
 * enforces it via the `resolver_mode: nats` attestation, design §5.1). The verb
 * always attempts the push; it cannot itself detect a silently-no-op resolver.
 */
export interface RevokeFederatedUserJson extends JsonFederatedUserOkBase {
  account: string;
  user: string;
  /** U-prefixed pubkey added to the account's revocation map (survives local delete). */
  revokedPubKey: string;
}

/**
 * Emit a single line of JSON to stdout and return. Caller is responsible for
 * setting the process exit code (0 for ok, 1 for !ok).
 *
 * Signature is the documented envelope union so a wrong-shaped payload is a
 * compile error, not a silent contract violation.
 */
export function emitJson(
  payload:
    | AddBotJson
    | ReissueBotJson
    | RemoveBotJson
    | SetupOperatorJson
    | ProvisionJson
    | AddFederationExportJson
    | InitOperatorJson
    | AddAccountJson
    | ExportAccountJson
    | ExportOperatorJson
    | ExportSystemJson
    | AddFederatedUserJson
    | ReissueFederatedUserJson
    | RevokeFederatedUserJson
    | JsonError
    | JsonFederationError
    | JsonOperatorError
    | JsonFederatedUserError,
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
