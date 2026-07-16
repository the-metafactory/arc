# REGISTRY.yaml schema

The registry is the single discovery surface for the metafactory ecosystem (the
legacy `catalog.yaml` path was retired in arc#323). `REGISTRY.yaml` lives in the
`the-metafactory/meta-factory` repo and is **generated** from the org scan +
`arc-manifest.yaml` files by arc's registry generator (`bun run
registry:generate`, arc#322). This document is the authoritative schema.

## Two orthogonal axes — do not conflate them

The single most important rule (arc#324): an entry carries **two independent
classification axes**, and each has its own vocabulary. They are never squeezed
into one word set.

| Axis | What it answers | Where it lives | Vocabulary |
|---|---|---|---|
| **Artifact class** | *What is it?* | the **section** the entry sits in (`skills:` / `agents:` / `prompts:` / `tools:` / `components:` / `rules:`) — mirrors the manifest `type` | skill, agent, prompt, tool, component, rules (+ `bundle: true` flag) |
| **Source trust** | *How much does the registry vouch for its origin?* | the entry's **`trust:`** field | `builtin` \| `community` \| `system` \| `custom` |

Before arc#324 the trust axis was stored in a field misleadingly named `type:`,
reusing the manifest **`tier`** words (`custom`/`community`) — so one word set
meant two different things (a package's self-declared tier *and* the registry's
source-trust). The field is now **`trust:`**, distinct from the manifest `tier`.

### "bundle" has exactly one meaning

`bundle` denotes a **multi-artifact repo** (a repo that ships more than one
installable artifact) — nothing else. It appears only as the optional
`bundle: true` flag on an entry. It is **not** a packaging verb: the CLI command
that produces a distributable tarball is `arc pack` (renamed from `arc bundle` in
arc#63) precisely to keep this word on one meaning.

## Entry fields

```yaml
registry:
  skills:            # section = artifact class
    - name: <string>            # REQUIRED — the artifact name (manifest name)
      description: <string>     # REQUIRED
      author: <github-handle>   # REQUIRED — manifest author.github
      version: <semver>         # manifest version
      source: <repo-url>        # REQUIRED — github.com/<owner>/<repo>
      trust: custom             # REQUIRED — SOURCE-TRUST axis (see table above)
      status: shipped           # curated lifecycle: shipped | beta | deprecated
                                #   (agents also use designed | scaffolded | published)
      has_cli: true             # optional — the repo provides a CLI
      bundle: true              # optional — multi-artifact repo (the ONLY meaning of bundle)
      # ── curated, manifest-less fields the generator PRESERVES across runs ──
      contributors: [<handle>]  # co-authors beyond the singular author
      core: true                # first-party core component
      reviewed_by: [<handle>]
      # agents additionally carry the cortex-Q2 capability schema:
      #   substrate, mode, category, risk_level, capabilities[], depends_on
```

### Generator-owned vs. curated

The generator **owns** (overwrites on every run from the manifest): `name`,
`description`, `author`, `version`, `source`, `trust`, `has_cli`, `bundle`.

Everything else is **curated** — hand-authored metadata no manifest carries
(`contributors`, `core`, `reviewed_by`, `status`, and the agents' cortex-Q2
capability schema). The generator's name-keyed merge preserves it; entries with
no scanned repo (aspirational/manifest-less) are kept verbatim. See
`src/lib/registry-generator.ts`.

### `trust` value mapping

External (Category-B, personal-org) repos are forced `trust: community` (spec
§5.2). For in-org repos the manifest `tier` maps to `trust`: `community` →
`community`; everything else (custom/official/core) collapses to `custom`
(`tierToTrust` in the generator). `builtin`/`system` are reserved for
hand-curated entries.

## Regeneration

```bash
bun run registry:generate            # rewrite REGISTRY.yaml (default ./REGISTRY.yaml)
bun run registry:generate --check    # exit 1 if the committed file is stale
```
