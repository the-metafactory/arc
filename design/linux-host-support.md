# Linux/Debian Host Support — Arc Design Specification

**Status:** Draft for review
**Created:** 2026-07-16
**Evidence:** Community Debian 13 bring-up (Vincent Zontini) — first Linux host in the deployment topology; validated systemd template units (cortex README-AGENTS.md Appendix A, cortex PR#2090); community gist runbook
**Related:** cortex#2071 (systemd unit auto-render), cortex `docs/design-arc-agent-bots.md` §3.2 + §11 Phase C.3, arc#117 (HostAdapter), arc#140 (darwin-launchd + linux-systemd adapter surface)

---

## Overview

arc can install, upgrade, verify, and remove packages on Linux today — the
symlink/database/manifest core is OS-agnostic. What Linux *lacks* is the
**supervision layer**: on macOS, `arc upgrade cortex` ends with rendered,
loaded launchd plists and a running assistant; on Debian the user hand-writes
systemd units, `loginctl enable-linger`, and wires start ordering themselves.

The seam for fixing this **already exists and was designed for exactly this
moment**:

- arc's `HostAdapter` registry (arc#117) ships a `linux-systemd` adapter —
  currently a **stub** (detect + paths only). Its own docstring defers install
  dispatch "once the first Linux host enters the deployment topology."
- The manifest schema already carries `provides.systemdUnit`
  (`src/types.ts:456`), sister to `provides.plist`.
- cortex's `docs/design-arc-agent-bots.md` §3.2 specifies the two-target
  install (cortex host + OS supervision host) with the systemd path named as
  the Linux mirror.

A community member has now completed a clean Debian 13 end-to-end bring-up —
the first Linux host — and validated the systemd **template unit** pattern
(`nats@.service` / `cortex@.service`, `%i` = stack slug) that this spec adopts
as the canonical Linux service shape. Their stated goal is the north star
here: *"It needs to be repeatable to automate it… see how easy a container
install could make the setup. Possibly provide a docker-compose.yaml file and
a .env template and then `docker compose up -d`."*

This spec turns that into four phased deliverables:

| Phase | Deliverable | Repo | Outcome |
|-------|------------|------|---------|
| **L1** | cortex renders its own systemd units | cortex (#2071) | `arc upgrade cortex` on Debian = running assistant, zero hand-written units |
| **L2** | arc `linux-systemd` install dispatch | arc | ANY `type: agent`/`tool` package with `provides.systemdUnit` installs + supervises on Linux |
| **L3** | Scripted first-install (env-driven quickstart) | cortex | The validated runbook becomes one idempotent script: env vars in → running assistant out |
| **L4** | Container path (compose + .env) | new repo or cortex `deploy/` | `docker compose up -d` = running assistant |

L1 unblocks today's users. L2 pays the architectural debt so every future
package gets Linux for free. L3 collapses the runbook into the repeatable
artifact the community asked for. L4 is the destination UX.

---

## Design Decisions

### DD-L1 — systemd **template units** are the canonical Linux service shape

One `nats@.service` + one `cortex@.service` in `~/.config/systemd/user/`,
instance-parameterized by stack slug (`systemctl --user enable --now
cortex@<slug>`). **Rationale:** community-validated on real Debian; a single
file pair serves every stack (no per-stack rendering, unlike launchd which has
no template mechanism); `After=`+`Wants=nats@%i.service` encodes ordering and
pull-up declaratively — something the launchd path does imperatively.
Consequence: the Linux renderer is *simpler* than `plist-render.sh` — it
renders two static files once, not N per stack.

### DD-L2 — user units, not system units

`systemctl --user` + `loginctl enable-linger`, mirroring launchd user agents.
No root beyond the one-time linger enable. Multi-stack co-tenancy under one
account matches the macOS posture.

### DD-L3 — the supervision renderer lives with the daemon it supervises

cortex renders cortex's units (postupgrade, like `plist-render.sh`); arc's
`linux-systemd` HostAdapter renders units for **arbitrary packages** that
declare `provides.systemdUnit`. arc does not special-case cortex. This
matches the existing darwin split (`plist-render.sh` in cortex vs
`launchd-install.ts` in arc) — README wording that said "arc renders systemd
units" was corrected in cortex PR#2090.

### DD-L4 — containers are a *distinct* supervision host, not a systemd variant

The `linux-systemd` adapter's `detect()` correctly fails in containers (no
`~/.config/systemd/user`). The container path (L4) supervises via the
container runtime (compose `restart:` policies), not systemd-in-docker.
Claude Code auth inside the container uses `CLAUDE_CODE_OAUTH_TOKEN` (already
honored by cortex's `cc-session.ts`, which suppresses `ANTHROPIC_API_KEY` when
it is set) — no interactive `claude login` in-container.

### DD-L5 — env-var contract is the automation interface

The validated runbook's variable set is promoted to a stable contract used by
L3 (quickstart script) and L4 (`.env` template) identically:
`CTX_PRINCIPAL`, `CTX_SLUG`, `CTX_NATS_PORT`, `CTX_NATS_MON`, `CTX_GUILD_ID`,
`CTX_CHANNEL_ID`, `CTX_LOG_CHANNEL_ID`, `CTX_MY_DISCORD_ID`, plus secrets
(`CTX_DISCORD_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`). One contract, two frontends.

---

## Phase L1 — cortex systemd auto-render (cortex#2071)

**What:** `scripts/lib/systemd-render.sh`, sibling of `plist-render.sh`,
invoked from `postinstall.sh`/`postupgrade.sh` when `uname == Linux`.

**Behavior:**
1. Render the two template units into `~/.config/systemd/user/` from the
   validated Appendix A shapes. Substitute nothing per-stack (template units —
   DD-L1); substitute only host-level tokens: bun path guard (mirror
   `resolve_bun_path`), `%h`-relative paths are literal.
2. Idempotent: re-render byte-identical → no-op; changed → write +
   `systemctl --user daemon-reload`.
3. `loginctl enable-linger` check: warn loudly (with the exact command) when
   linger is off — do NOT sudo automatically.
4. Per running stack (discover via `discover_stack_slugs`, same as plist path):
   `systemctl --user restart cortex@<slug>` after upgrade — the systemd mirror
   of the plist reload path.
5. No-op gracefully on hosts without systemd (container detection per DD-L4).

**Acceptance criteria:**
- [ ] Fresh Debian: `arc install <cortex-url>` → `cortex stack create` →
      `arc upgrade cortex` → `systemctl --user enable --now nats@<slug>
      cortex@<slug>` works with **zero hand-written files**.
- [ ] Upgrade restarts running stacks; stopped stacks stay stopped.
- [ ] Unit contents byte-match README-AGENTS.md Appendix A (single source:
      render from `src/services/*.service` templates checked into cortex,
      and Appendix A references those files rather than inlining, post-L1).
- [ ] bats/shell tests: fail-on-missing-bun, idempotency, daemon-reload only
      on change. CI-runnable on ubuntu-latest runner.

## Phase L2 — arc `linux-systemd` install dispatch

**What:** fill the stub — the systemd mirror of `launchd-install.ts`.

**Behavior:**
1. `renderUnit(template, tokens)` — same `{{TOKEN}}` substitution as
   `renderPlist`; shared token builder (extract common helper).
2. Install: symlink `provides.binary` into `binDir`; render
   `provides.systemdUnit` into `unitDir`; `systemctl --user daemon-reload` +
   `enable --now <unit>`.
3. Remove: `disable --now` + delete unit + `daemon-reload` (mirror launchd
   remove; orphaned-unit check in `arc verify`).
4. `supports()`: `agent` + `tool` (already correct in the stub).
5. Record in packages.db exactly as launchd installs do (`LaunchdInstallRecord`
   → generalize or sister `SystemdInstallRecord`).

**Acceptance criteria:**
- [ ] A `type: agent` package declaring `targets: [cortex, linux-systemd]` +
      `provides.systemdUnit` installs end-to-end on Debian in one
      `arc install` transaction (per design-arc-agent-bots §3.2).
- [ ] `arc remove` leaves no unit file, no enabled service, no dangling
      symlink (test the cleanup — CLAUDE.md anti-rationalization rule).
- [ ] All dispatch is behind the HostAdapter interface — zero
      platform-conditionals in command files.
- [ ] Tests via `createTestEnv()` with `unitDir`/`binDir` overrides; systemctl
      invocations behind an injectable runner (no real systemd in unit tests);
      one e2e on ubuntu-latest CI with real `systemctl --user`.

## Phase L3 — scripted first-install (quickstart)

**What:** `cortex quickstart` (or `scripts/quickstart-linux.sh`) that executes
the validated gist flow non-interactively from the DD-L5 env contract.

**Behavior:** check prerequisites (bun, claude auth — with the actionable
re-login message from cortex#2068, nats-server, linger) → write the nats
`.conf` → `stack create --apply` → seed provisioning (postupgrade path) →
patch the three config files from env (guild/channel/token/discord-id — the
only manual edits in the current runbook) → enable + start units → run the §5
healthy-boot gate and print the pass/fail table.

**Acceptance criteria:**
- [ ] From a fresh Debian box with only the env file filled in: one command →
      assistant replies to @mention.
- [ ] Idempotent re-run: no duplicate stacks, no clobbered configs (respects
      the scaffold's refuse-overwrite).
- [ ] Secrets end up `0600` (already guaranteed by cortex#2068) and never
      echoed to stdout/logs.
- [ ] The README quickstart section shrinks to: fill env file, run script.

## Phase L4 — container path (compose)

**What:** `deploy/compose/` — `docker-compose.yaml` + `.env.example` +
`Dockerfile.cortex`: `docker compose up -d` = running assistant.

**Shape (initial):** two services — `nats` (official image, JetStream on,
volume for store) and `cortex` (Debian-slim + bun + claude CLI + cortex,
running L3's quickstart as entrypoint against env). `restart: unless-stopped`
supervises (DD-L4). Volumes: `~/.config/metafactory/cortex` (config),
`~/.local/state/metafactory/cortex` (state/logs), nats store.

**Known challenges (tracked as spec open questions, resolved during L4):**
- Claude Code auth: `CLAUDE_CODE_OAUTH_TOKEN` via `.env` (DD-L4). Token
  lifetime/refresh behavior in a headless container needs validation — the
  cortex#2068 auth-failure message is the safety net.
- Dispatched CC sessions exec tools inside the container — image must carry
  the minimum toolchain (git, gh, ripgrep); size vs capability tradeoff.
- Upgrade model: `docker compose pull && up -d` replaces `arc upgrade` —
  image build pipeline (GH Actions, tag per cortex release) is in scope.

**Acceptance criteria:**
- [ ] Fresh machine with Docker: fill `.env`, `docker compose up -d`,
      assistant replies to @mention.
- [ ] Container restart preserves stack identity, seeds, and session state
      (volumes hold all mutable state).
- [ ] Image rebuilt + tagged automatically per cortex release.

---

## Out of scope

- System-level (root) systemd units, other distros' packaging (apt/deb),
  Windows/WSL.
- Kubernetes/helm (compose first; k8s only if community demand materializes).
- Replacing launchd on macOS with anything else.

## Open questions

1. **L2 record shape** — generalize `LaunchdInstallRecord` to
   `SupervisionInstallRecord` or add a sister type? (Lean: generalize.)
2. **L3 home** — `cortex quickstart` subcommand (TypeScript, testable) vs
   shell script (matches gist)? (Lean: subcommand; the gist stays the
   human-readable reference.)
3. **L4 base image** — build claude CLI into the image (bigger, reproducible)
   vs install at first boot (smaller, drift-prone)? (Lean: build in.)
4. Does the nats container use the official `nats:` image or the same binary
   layout as bare-metal for config parity? (Lean: official image + mounted
   `.conf` — parity is in the conf file, not the binary path.)

## Rollout / sequencing

L1 and L2 are independent (different repos) and can proceed in parallel; L3
depends on L1 (units must exist to enable); L4 depends on L3 (quickstart is
the entrypoint). Community validation loop: the Debian tester who validated
the units is the natural first user for each phase — plan a checkpoint per
phase in the community #cortex thread before declaring done.
