# Agent identity provisioning at install (F-6b / arc#228)

When `arc install` lands a `type: agent` package, the agent instance is given a
signing identity and a state skeleton automatically — no manual post-install
steps. This closes the F-6b gap in the dev-loop blueprint (cortex
`docs/design-agentic-dev-pipeline.md` §6.2 step 2, §6.4).

Implementation: [`src/lib/identity-provision.ts`](../src/lib/identity-provision.ts),
wired into [`src/commands/install.ts`](../src/commands/install.ts) as a single
hook call (`maybeProvisionAgentIdentity`) at the identity step of both the
standalone and library-artifact install paths.

## What gets provisioned

| Artifact | Location | Notes |
|---|---|---|
| **NKey seed** | `~/.config/nats/<agent-id>.nk` | chmod 600. The signing identity the agent's daemon binds to. Generated in-process (Ed25519 via `@noble/ed25519` + base32/CRC16 NKey codec) — no external `nsc`/`nkeys.js` dependency. Mirrors cortex `stack-identity-provision.sh`. |
| **DID** | `did:mf:<agent-id>` | Mechanical derivation, recorded in instance metadata. No principal segment — agents are named entities; the publishing stack encodes principal via subject scope. |
| **Instance state** | `~/.config/cortex/agents/<agent-id>/` | `state.sqlite` (provisioning metadata), `dashboard.md`, `CLAUDE.md`, `context/{repos,channels}.md`, `retros/`. Mirrors the agent-state `ScaffoldFolders` layout. |

## Agent-id resolution

`MF_AGENT_ID` env → `manifest.identity.id` → slug of `manifest.name`.

The id must match `^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$` (lowercase alphanumeric +
single internal hyphens). A malformed id is refused (fail-closed) rather than
written to a bad path.

## Environment contract

| Var | Purpose |
|---|---|
| `MF_AGENT_ID` | Override the manifest-derived agent id. |
| `MF_INSTANCE_DIR` | Override the default instance-state dir (`~/.config/cortex/agents/<id>`). |
| `MF_NATS_DIR` | Override the NKey seed base (`~/.config/nats`). Hosts/tests redirect; production leaves it. |
| `MF_PRINCIPAL` | Logged for correlation only; **never** used for identity derivation. |

## Idempotency (Rule 2)

Re-running provisioning on an already-provisioned agent is safe:

- An existing NKey seed is **reused**, never regenerated.
- Operator-edited files (`dashboard.md`, `CLAUDE.md`, `context/*`) are **never
  overwritten** — file exists → skipped.
- Partial state (seed present, dirs missing) scaffolds only the missing pieces.

This survives `arc upgrade` cycles.

## Fail-closed rules (cortex#563 precedent)

cortex#563 taught the lesson: never wire identity into a config/state that can't
anchor it (there, an `nkey_seed_path` without a `stack.id` Zod-rejected at boot
and crash-looped the service). The analogue here:

1. **No identity without a state skeleton.** If the instance-state dir cannot be
   created (e.g. permission denied), the hook WARNs with actionable guidance and
   **does not** write an orphan NKey seed. The install still succeeds; the agent
   boots unidentified until the operator closes the gap.
2. **Generation failure → guidance, not crash.** NKey generation is
   self-contained (Ed25519 + NKey codec), so it only fails on a real crypto/IO
   error (e.g. the seed path became unwritable). In that case the hook emits
   guidance and returns `provisioned: false` rather than crashing. Pubkey
   derivation is best-effort — an empty pubkey is acceptable (cortex logs it at
   boot for the operator to copy in).

Every failure path returns a result with `provisioned: false` + a `warning`
string; the hook never throws and never aborts the install.

## Troubleshooting

- **"could not generate an NKey seed"** — the seed path isn't writable (the
  generator is in-process, so this is an IO/permission error, not a missing
  tool). Fix the `~/.config/nats` permissions or set `MF_NATS_DIR`, then re-run.
- **"cannot create agent instance dir"** — the target path isn't writable. Set
  `MF_INSTANCE_DIR` to a writable path or fix permissions.
- **"invalid agent id"** — set `manifest.identity.id` (or `MF_AGENT_ID`) to a
  lowercase, hyphen-clean slug.
- **Empty `nkey_pub` in metadata** — expected when `nkeys.js` is absent; cortex
  derives and logs the pubkey at boot.

## Merge-coordination note (concurrent arc install lanes)

F-6b keeps its logic in a dedicated module and a single, clearly-commented hook
call at the identity step — deliberately non-adjacent to the F-6c (library
ordering, `install-transaction.ts`) and F-6e (secret provisioning) insertion
points, to minimize batch-merge conflict across the concurrent install lanes.
