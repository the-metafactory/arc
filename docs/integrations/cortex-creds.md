# Cortex creds integration

This document defines the stable contract between `cortex creds *` (consumer) and `arc nats *` (provider). It is the contract that arc#131 stabilises and that cortex#79 will shell out to.

## Background

arc owns the full NATS credential lifecycle via four commands that wrap [`nsc`](https://github.com/nats-io/nsc):

| Command | Purpose |
|---|---|
| `arc nats add-bot <name>` | Mint per-bot creds + sign user JWT |
| `arc nats reissue-bot <name>` | Rotate creds — revoke old pubkey, mint new |
| `arc nats remove-bot <name>` | Revoke + push server-side, optionally delete the local `.creds` file |
| `arc nats setup-operator <account> --bots …` | Provision multiple bots in one shot (operator bootstrap) |

Cortex (and any other tool) consumes these as a thin delegator over a structured JSON contract — never by parsing human-readable stdout. Cortex never gets `$SYS` access; arc/nsc owns the auth boundary.

## Contract

### Schema versioning

Every JSON response carries:

```json
{ "schema": "arc.nats.v1", "ok": <bool>, ... }
```

`arc.nats.v1` is the schema string in this document. Breaking changes — renaming, removing, or changing the type of any field documented below — require a major version bump (`arc.nats.v2`) and a deprecation period. Adding optional new fields under the same `v1` schema is permitted; consumers must tolerate unknown keys.

### Exit codes

- `ok: true` → exit `0`.
- `ok: false` → exit non-zero (currently `1`).
- For `setup-operator`, exit `0` only when **every** bot succeeded. If any bot fails, exit `1` while still emitting the per-bot results.

Consumers can branch on either exit code or `ok` — both signals are authoritative.

### Error envelope

```json
{
  "schema": "arc.nats.v1",
  "ok": false,
  "error": { "code": "<CODE>", "message": "<human-readable detail>" }
}
```

#### Error code taxonomy

| Code | When |
|---|---|
| `NSC_NOT_INSTALLED` | `nsc` binary missing from `$PATH`. Install: `brew install nats-io/nats-tools/nsc`. |
| `NSC_COMMAND_FAILED` | An `nsc <subcommand>` exited non-zero (e.g. signing-key missing, permission denied, malformed account state). The error `message` field carries the nsc subcommand name and the captured stderr. |
| `USER_NOT_FOUND` | Bot user does not exist under the named account (revoke / reissue path). |
| `ACCOUNT_NOT_FOUND` | Operator account cannot be detected (no nsc config, no `--account` flag). |
| `ALREADY_EXISTS` | User or creds file already exists at the target path and `--force` was not passed. |
| `PUSH_FAILED` | `nsc push -a <account>` failed after `revocations add-user` succeeded. **The user JWT is still valid on the bus** — operator must resolve connectivity and retry. |
| `REVOKE_FAILED` | `nsc revocations add-user` itself failed (often: missing account signing key). |
| `VALIDATION_ERROR` | Bot name, subject expression, or `--bots` flag failed validation. |
| `INVALID_USER_KEY` | `nsc describe user -J` returned malformed JSON or a non-U-prefixed `sub` claim. |
| `ROLLBACK_FAILED` | A multi-step operation failed mid-way and best-effort rollback also failed; operator must manually reconcile. |
| `UNKNOWN` | Unclassified failure. Treated as a bug — file an arc issue. |

Consumers MUST handle the documented codes by name; for unknown codes, fall back to surfacing `message` to the user and exiting non-zero.

### Command schemas

#### `arc nats add-bot <name> --json`

**Flags:** `-a, --account`, `--pub`, `--sub`, `-o, --output`, `--force`, `--with-identity`, `--json`

**Success:**

```json
{
  "schema": "arc.nats.v1",
  "ok": true,
  "bot": "jc-pilot",
  "account": "OP_JC",
  "credsPath": "/Users/.../.config/nats/jc-pilot.creds",
  "jwt": "eyJ...",
  "pubKey": "UAFAKEPUBKEY..."
}
```

- `credsPath` is the absolute path of the written `.creds` file (mode `600`, under a `700` directory).
- `jwt` is the body of the `BEGIN NATS USER JWT` block from the creds file (the encoded JWT itself, no PEM markers). It may be empty if the creds file shape is unexpected — cortex should consider `pubKey` authoritative in that case.
- `pubKey` is the durable U-prefixed NKey from the user JWT's `sub` claim — the same identifier the revoke flow uses. **This is the key cortex should bind to internally**, not the bot name.

#### `arc nats reissue-bot <name> --json`

**Flags:** `-a, --account`, `-o, --output`, `--json`

**Success:**

```json
{
  "schema": "arc.nats.v1",
  "ok": true,
  "bot": "jc-pilot",
  "account": "OP_JC",
  "credsPath": "/Users/.../.config/nats/jc-pilot.creds",
  "newPubKey": "UANEWKEYAFTERREISSUE...",
  "revokedPubKey": "UAOLDKEYFROMBEFOREREISSUE..."
}
```

- `revokedPubKey` is the OLD user pubkey that was added to the account's revocation map and pushed (the arc#132 surface). On the bus, all `.creds` carrying this pubkey will be rejected by the NATS server going forward.
- `newPubKey` is the post-rotation pubkey. Cortex should update its bound identifier to this value before considering the rotation complete.

#### `arc nats remove-bot <name> --json`

**Flags:** `-a, --account`, `-o, --output`, `--delete-creds`, `--json`

**Success:**

```json
{
  "schema": "arc.nats.v1",
  "ok": true,
  "bot": "jc-pilot",
  "account": "OP_JC",
  "revokedPubKey": "UAREVOKEDKEY...",
  "credsFileDeleted": true
}
```

- `revokedPubKey` is what was added to the account revocation map and pushed (same semantics as `reissue-bot.revokedPubKey`).
- `credsFileDeleted` reflects the outcome of the `--delete-creds` flag:
  - `true` — `--delete-creds` was set AND the file existed AND was deleted.
  - `false` — `--delete-creds` was not set, OR the file was already missing (in which case the bot was still revoked + deleted server-side).

#### `arc nats setup-operator <account> --bots <list> --json`

**Flags:** `--bots <comma-separated>` (required), `--force`, `--json`

**Success (mixed outcome):**

```json
{
  "schema": "arc.nats.v1",
  "ok": true,
  "account": "OP_JC",
  "bots": [
    { "bot": "jc-pilot", "ok": true,  "credsPath": "/Users/.../jc-pilot.creds", "pubKey": "U..." },
    { "bot": "jc-luna",  "ok": false, "error": { "code": "ALREADY_EXISTS", "message": "..." } }
  ],
  "summary": { "total": 2, "ok": 1, "failed": 1 }
}
```

- The outer envelope is `ok: true` because `setup-operator` ran to completion. Per-bot success/failure is in `bots[*].ok`.
- Exit code is `0` only if `summary.failed === 0`. Mixed outcomes exit `1` so a naive `if !arc nats setup-operator ...` shell check still catches partial failure.
- Each successful entry carries `credsPath` and `pubKey`; failed entries carry `error.code` + `error.message` from the same taxonomy as above.

### Operator-topology commands (schema `arc.nats.operator.v1`)

`arc nats init-operator` + `arc nats add-account` (arc#252) are the
sovereign-operator primitives `cortex network provision <stack>` (cortex#1139,
Model-B sovereign federation) wraps alongside `add-bot` + `add-federation-export`.
Each principal runs their OWN nsc operator and mints their own accounts (cortex
ADR-0013); arc owns the nsc boundary, cortex orchestrates but never runs nsc.

They emit a **separate** schema namespace — `arc.nats.operator.v1` — so consumers
that guard on `arc.nats.v1` are unaffected. Same exit-code + error-envelope rules
as above; error codes are drawn from the same taxonomy (`NSC_NOT_INSTALLED`,
`NSC_COMMAND_FAILED`, `VALIDATION_ERROR`).

#### `arc nats init-operator --json`

**Flags:** `--name <operator>` (default: current nsc operator), `--force`, `--json`

Idempotent: a no-op when the operator already exists (`created: false`). `--force`
recreates an existing operator (`nsc add operator --force`) — **destructive**: it
regenerates the operator identity key and orphans everything signed under the old
one. The operator seed is managed by nsc in its keystore at mode `0o600`.

**Success:**

```json
{
  "schema": "arc.nats.operator.v1",
  "ok": true,
  "operator": "OP_ANDREAS",
  "pubKey": "OAKONKIYJN3VVHOTJD3LZDEZOE3PRDCPFJZBXHWF2WJT6LHDYPXFGLUL",
  "created": true,
  "alreadyExisted": false,
  "seedPath": "/Users/.../.local/share/nats/nsc/keys/keys/O/AK/OAKON....nk"
}
```

- `created` — `true` iff `nsc add operator` ran this invocation (fresh create or `--force` recreate).
- `alreadyExisted` — `true` iff the operator existed before this invocation.
- `seedPath` — keystore path of the operator seed (mode `0o600`), or `null` if the file could not be located (non-default keystore layout). The operator is still created either way.

#### `arc nats add-account <name> --json`

**Flags:** `--json`. Account names are strict UPPER_SNAKE (`[A-Z][A-Z0-9_]+`).

Operates on the **current operator** context (set by `init-operator` or `nsc env`).
Idempotent, so it is safe to call repeatedly with different names — cortex uses it
for BOTH the federation account and a per-stack agents account (ADR-0012 isolation).

**Success:**

```json
{
  "schema": "arc.nats.operator.v1",
  "ok": true,
  "account": "FEDERATION",
  "pubKey": "AAPH4GU2MPJ2LH44ZWMN3UL7J73JDZJNYRV26G7AL2NKY76FRWHV6D36",
  "created": true,
  "alreadyExisted": false
}
```

- `created` — `true` iff `nsc add account` ran this invocation.
- `alreadyExisted` — `true` iff the account existed before this invocation.

### Federated-user mint (schema `arc.nats.federated-user.v1`)

#### `arc nats add-federated-user <name> --json`

**Flags:** `--account <ACCOUNT>` (**required**, UPPER_SNAKE — hub topology is
never inferred from the nsc env), `--output <path>` (default
`~/.config/nats/<name>.creds`), `--json`.

The scoped hub-transport user mint for cortex's operator-mode `admit --and-seal`
(cortex#1598, design §5.3/§5.4). Names are `<principal>.<stack>` — dotted, so
the scope template's `{{name()}}` expansion lands the stack segment on its own
subject token.

**Least privilege is code, not flags:** the permission set is HARDWIRED — one
`federated`-role scoped signing key per account carries
`sub: federated.{{name()}}.>,_INBOX.>` (own scope only) and
`pub: federated.>,_INBOX.>` (the cross-principal wire); the minted user is
signed by that key and carries **no permissions of its own**. There are no
permission flags to typo.

Both halves are probe-first idempotent: the scoped key is created once and
never silently rewritten; an existing user signed by the scoped key is
re-exported (`userAlreadyPresent: true`). An existing user signed by **any
other key** is refused with `USER_NOT_SCOPED` — re-exporting it would hand out
an unscoped credential.

**Success:**

```json
{
  "schema": "arc.nats.federated-user.v1",
  "ok": true,
  "account": "FEDERATION",
  "accountPubKey": "AA…",
  "user": "jc.default",
  "userPubKey": "UD…",
  "signingKeyPubKey": "AB…",
  "scopeCreated": false,
  "scopeAlreadyPresent": true,
  "userCreated": true,
  "userAlreadyPresent": false,
  "credsPath": "/Users/.../.config/nats/jc.default.creds",
  "jwt": "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ…",
  "subTemplate": "federated.{{name()}}.>,_INBOX.>",
  "pubTemplate": "federated.>,_INBOX.>"
}
```

**Error codes** (beyond the shared taxonomy): `SIGNING_KEY_FAILED` (scoped-key
create/verify failed), `USER_NOT_SCOPED` (existing user not governed by the
`federated` scope — resolve manually, never auto-clobbered), plus
`ACCOUNT_NOT_FOUND`, `VALIDATION_ERROR`, `NSC_COMMAND_FAILED`,
`NSC_NOT_INSTALLED`.

## Path resolution

By default `arc nats add-bot` writes the `.creds` file to:

```
$HOME/.config/nats/<bot>.creds       (mode 600)
$HOME/.config/nats/                  (mode 700)
```

Override with `-o, --output <path>`. The JSON envelope always returns the absolute path actually written under `credsPath` — cortex should read that, not reconstruct the path itself.

## Failure modes cortex must handle

| Scenario | Code(s) | What cortex should do |
|---|---|---|
| First-time setup on a host without nsc | `NSC_NOT_INSTALLED` | Surface install instructions; do not retry. |
| `arc nats` invoked without an active operator account | `ACCOUNT_NOT_FOUND` | Ask the operator to run `nsc env -a <account>` or pass `--account` explicitly. |
| Reissue/remove of a bot that was never minted | `USER_NOT_FOUND` | Treat as benign for `remove` (idempotent intent); fail loudly for `reissue`. |
| Revoke succeeded locally but `nsc push` failed | `PUSH_FAILED` | **Do not** consider the bot revoked. The old creds remain valid on the bus. Retry the same command after fixing connectivity. |
| Mid-reissue catastrophic failure | `ROLLBACK_FAILED` | Surface to operator; the old creds are revoked server-side but the new ones may not exist. Manual recovery: `nsc add user -a <account> -n <name>` + `arc nats reissue-bot <name>`. |

## Stability promise

Once shipped (arc v0.4.x onwards), the four command names + `--json` schema in this document are part of arc's public CLI contract. The bar for changing them matches the SDK surface:

1. Adding an optional field under `arc.nats.v1` is non-breaking.
2. Removing, renaming, or retyping any documented field requires:
   - A new schema version (`arc.nats.v2`),
   - Both schemas supported concurrently for one minor release cycle (deprecation period),
   - A migration note in the arc release notes.
3. Adding a new error code is non-breaking. Removing or renaming an existing code requires the same v2 + deprecation discipline.
4. Adding a new command under the `arc nats *` umbrella is non-breaking; cortex code paths for the four documented commands remain stable.

## See also

- `arc nats` source: `src/commands/nats.ts`
- JSON helper + types: `src/lib/json-response.ts`
- Tests: `test/commands/nats-json.test.ts`
- The revoke flow that makes `revokedPubKey` real: arc#130 / arc#132 (server-side revocation + push)
- Consumer side: `cortex#79` (rewrite `cortex creds *` as shell-out to `arc nats --json`)
