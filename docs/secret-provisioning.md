# Secret provisioning at install (F-6e, arc#229)

`type: agent` packages declare the scoped credentials they need in their
manifest:

```yaml
capabilities:
  secrets:
    - APPROVER_GH_TOKEN
    - CORTEX_DEV_GH_TOKEN
```

arc provisions those secrets at install time and injects them into the agent's
**per-agent environment** — never into a brief or a log (cortex
`docs/design-agentic-dev-pipeline.md` §6.2 step 5, §3.5b authority model).

## Install-time flow

`arc install <pkg>` detects `capabilities.secrets` and, for each declared name:

| Mode | Flag | Behaviour |
|---|---|---|
| **Interactive** | *(default)* | Securely prompt (no echo). Press Return to skip a secret. |
| **From env** | `--from-env` | Read each declared secret from the current environment. CI / scripted installs. |
| **Skip** | `--skip-secrets` | Store nothing. The daemon starts and fails at first use with a clear message. |

A storage failure aborts the install cleanly (no symlinks placed yet). A skipped
secret only WARNs — listing the missing NAMES and the `arc secrets set …`
command to provision them later.

The motivating examples are the dev-loop's own credentials —
`APPROVER_GH_TOKEN` (approver-bot merge gate) and `CORTEX_DEV_GH_TOKEN` (dev
agent's scoped forge token).

## Storage backends

| Platform | Native | Fallback |
|---|---|---|
| macOS | Keychain via the `security` CLI. Service key `ai.meta-factory.cortex.<agent>.<NAME>`, account-scoped to the principal's username. | chmod-600 file |
| Linux | systemd `LoadCredential` resolves the file at daemon-start (no install-time backend) | chmod-600 file |
| any | — | `~/.config/metafactory/secrets/<agent>/<NAME>`, one secret per file, chmod 600 enforced on every write **and** read (cortex#87) |

`resolveSecretBackend()` picks the native backend when available, else the
universal chmod-600 `FileBackend`.

## Injection

- **Postinstall env** — `arc install` injects the agent's stored secrets into
  the postinstall child's environment only. The env is a fresh object scoped to
  that child invocation; arc's own process env is never mutated, so the secrets
  are gone the moment postinstall exits.
- **Plist / systemd render** — the service template references the stored secret
  by name; the resolver reads it from the backend at render / daemon-start time.

## Lifecycle verbs

```
arc secrets list   <agent>            # stored secret NAMES (never values)
arc secrets check  <agent>            # declared vs stored; exit 1 if any missing
arc secrets set    <agent> <secret>   # prompt securely, or --from-env
arc secrets rotate <agent> <secret>   # no in-place overwrite (delete then add)
arc secrets remove <agent> [<secret>] # one secret, or all declared when omitted
```

## Never-log invariant (issue §E)

A secret **value** never reaches stdout, stderr, an argv arc logs, or an audit
line. Every verb and warning prints NAMES only. The only ingress is the prompt /
env read; the only egress is the storage backend and the per-child env. The
`redactSecret()` helper is the single string a diagnostic may print in a value's
place: `(secret redacted)`.

Other guardrails:

- **chmod 600** enforced on the file fallback on every write and read.
- **No in-place overwrite on rotate** — delete then add (two steps).
- **One secret per file** — no mixing in the file backend.
- **Keychain/file scope** — locked to the principal's user account; a
  daemon-start retrieval failure is loud (with a hint to re-run `arc secrets
  set`), never silent.
