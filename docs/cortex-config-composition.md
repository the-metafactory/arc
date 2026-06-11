# Cortex config composition at install (F-6a / cortex#858)

When `arc install` lands a package whose manifest declares a `cortex_config`
fragment AND the install target host is a cortex stack, arc merges the package's
declared capabilities/policy into the stack's config automatically — no manual
editing of `stacks/<id>.yaml`. This closes the F-6a gap in the dev-loop
blueprint (cortex `docs/design-agentic-dev-pipeline.md` §6.2 install lifecycle
step 3 / "step 6c", §6.4).

Implementation: [`src/lib/cortex-config-provision.ts`](../src/lib/cortex-config-provision.ts),
wired into [`src/commands/install.ts`](../src/commands/install.ts) as a single
hook call (`maybeMergeCortexConfig`) at the cortex-config step of both the
standalone and library-artifact install paths — AFTER the post-landing
transaction (so postinstall has run), non-adjacent to the F-6b identity hook and
the F-6e secrets hook.

## The `cortex_config` manifest field

Optional. The package's CORTEX capability/policy declaration — distinct from
`capabilities`, which is arc's OWN host-side enforcement (what the package may
read/write/network/shell locally). Two mutually-exclusive forms:

```yaml
# Inline form — capabilities and/or policy, NOTHING else.
cortex_config:
  capabilities:
    - id: dev.implement
      description: "Dev agent implementation"
      provided_by: [dev-agent]
  policy:
    principals:
      - id: dev-agent
        role: [develop]
    roles:
      - id: develop
        capabilities: [dev.implement]
```

```yaml
# Path-pointer form — a relative path to a YAML fragment shipped in the package.
cortex_config:
  path: cortex-config.yaml
```

A fragment may carry ONLY `capabilities` and/or `policy`. arc rejects any other
top-level key (`agents`, `principal`, `nats`, …) at manifest-read time so a
package can't smuggle a transport/identity change in through the merge path —
that config is the stack's, not the package's. The path form is guarded to a
relative path with no `..` traversal.

## What runs

arc does NOT reimplement the merge (Anti-Abstraction Gate). It invokes the
cortex CLI verb, which owns the deep semantics:

```
cortex config merge --config <stack-config-dir> --fragment <file> [--stack <id>]
```

| cortex-side behavior | Consequence for arc |
|---|---|
| id-keyed deep merge (capabilities/principals/roles), fragment-wins | The package's declarations land in `stacks/<id>.yaml`. |
| **idempotent** — same fragment twice is a no-op | A retry after a partial failure is safe. |
| `CortexConfigSchema.parse()` of the composed whole before write | A fragment that would break the stack is rejected; install fails closed. |
| timestamped 0o600 backup + post-write re-compose, restore-on-failure | A failed merge never leaves the stack unloadable. |

arc's job is to (1) decide the step applies, (2) marshal the fragment to a file,
and (3) map the verb's exit code to a fail-closed result.

## When the step fires

| Condition | Behavior |
|---|---|
| No `cortex_config` in the manifest | No-op (success). |
| `cortex_config` present, target host NOT a (detected) cortex stack | No-op (success) — the fragment applies only when the package is installed onto a cortex stack. |
| `cortex_config` present + target host IS cortex | Invoke `cortex config merge`. |

Host-is-cortex reuses the existing host adapter (`host.id === "cortex"` AND
`host.detect()` — a materialized `cortex.yaml`). The stack config dir is the
cortex host's `paths.root`. The target stack id is passed through
`InstallOptions.cortexStackId` → `--stack` (cortex needs it only when the config
dir holds more than one `stacks/*.yaml`).

## cortex CLI resolution

`ARC_CORTEX_BIN` / `MF_CORTEX_BIN` env (an explicit path; a `.ts` target is run
with `bun`) → `cortex` on PATH. If neither resolves and the package needs a
merge, the install **fails closed** with guidance to put `cortex` on PATH (or
set `ARC_CORTEX_BIN`) and retry — the merge is idempotent, so a retry is safe.

## Fail-closed + rollback

A non-zero exit from the verb fails the install. The landed state is unwound:
the install transaction rolls back symlinks/hooks/extensions/launchd, and
because the DB row was committed as the transaction's last step (BEFORE this
step runs), the cortex-config step removes the row itself. Because the cortex
verb is idempotent and writes a backup, an arc retry after fixing the cause
re-runs cleanly.

## Composition with the other F-6 slices

| Slice | Concern | Module | Insertion point |
|---|---|---|---|
| F-6c (arc#231) | ordered library installs + atomic rollback | `install-transaction.ts` | per-artifact transaction |
| F-6b (arc#233) | agent identity provisioning | `identity-provision.ts` | identity step |
| F-6e (arc#234) | secret provisioning | `secret-provision-install.ts` | secrets step (before preinstall) |
| **F-6a (cortex#858)** | **cortex config composition** | **`cortex-config-provision.ts`** | **cortex-config step (after the transaction)** |

Each slice is a single, clearly-commented, non-adjacent hook so the lanes
compose without stepping on each other.
