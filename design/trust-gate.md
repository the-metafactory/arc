# Arc as a Trust Gate — Component Signing, Scanning, and Existing Controls

**Status:** Design draft (for discussion)
**Created:** 2026-07-17
**Provenance:** community discussion (Robert Chuvala's sovereignty/verification question re: distributing infra blueprints as metafactory.ai components) + the PRINCIPLES set in cortex#1381 (#8–#12). This note applies that doctrine to the supply chain.
**Related:** `src/lib/manifest.ts` (capability declaration), `src/lib/cosign.ts` (signing), `src/lib/source-resolver.ts` + trust tiers, the confidentiality-gate scan engine.

---

## The problem

A distributed component runs in the **deployer's** tenant, with the deployer's credentials. The deployer must be able to answer, *before it touches their account*: is this really from who it claims, has it been tampered with, what can it reach, and does its actual content match that claim — **without trusting the publisher, the marketplace operator, or any model's account of the artifact.**

This is not a new trust model. It is PRINCIPLES #9, #10, and #12 applied to "installing someone else's code":

- **#9 — gate on what happened, not what it claims.** A signature and a scan are *observable facts* (cryptographic / deterministic), never the author's or a model's word.
- **#10 — controls live where the agent has no hands.** Verification runs in the **deployer's** arc, on the deployer's machine — where the *publishing* agent has no reach. That is what makes it "a scan the model can't forge": the publishing model is not in the trust path at all.
- **#12 — deterministic gates; the model only advises.** A model may flag "this capability combination is unusual"; it is never the install condition.

## Four questions, four independent controls

Each control answers a **different** question. None is sufficient alone; the composition is defence in depth. arc is the composition point.

| # | Question | Control | What it does NOT prove | State |
|---|----------|---------|------------------------|-------|
| 1 | Where did it come from? | **Trust tier** — trust flows from the *source* (official / community / custom), setting the default posture (auto-approve / confirm / full review). | Nothing about the artifact's integrity or content. A trusted source can ship a compromised artifact. | ✅ exists |
| 2 | Is it authentically that, unmodified? | **Cryptographic signature** — cosign / Sigstore provenance binds the artifact to a publisher identity + a build, giving tamper-evidence, attributable authorship, and a revocation anchor. | **Safety.** A validly signed package can be hostile — signing a payload does not sanitise it. | partial (`cosign.ts`) |
| 3 | What does it declare it can reach? | **Capability manifest** — `arc-manifest.yaml` declares every capability the package uses; an *undeclared* capability is a security bug. Shown at install. | That the declaration is *true*. It is a promise, not a proof, until something checks it. | ✅ exists |
| 4 | Does the artifact match its claim — and is it free of known-bad? | **Scan** (deterministic, unforgeable) — (a) content scan for secrets / known-bad patterns (the confidentiality-gate engine); (b) declared-vs-actual capability check (does the code only reach what the manifest declares?). Turns the manifest from a promise into a checked fact. | Novel / obfuscated malice. Scanning is incomplete alone. | content ✅; capability-diff = frontier |

Then, above these:

- **The human at the reversibility line (#8)** — for anything that touches credentials, deploys to the deployer's tenant, or is otherwise irreversible, a human tick. Below the line (a component that only reads, or writes within its own sandbox) can be auto.
- **A named receipt + append-only log (#9 / #10)** — every install records what was installed, from what source, which signature verified, and what the scan found, in a place the installing agent cannot rewrite.

## Why the layers compose (each covers the others' blind spots)

- The **signature** catches tampering a scan might miss (a modified-but-plausible artifact).
- The **scan** catches malice a valid signature cannot see (the signature says *who*, not *what*).
- The **manifest + capability-diff** catches reach the signature and tier don't (an authentic, clean-scanning package that still declares — or exercises — more than it should).
- The **human at the line** catches what all of them miss on the actions that can't be undone.

Signing and scanning are therefore **complementary, not substitutes**: signing answers *who + unmodified*; scanning answers *what's inside*. Shipping one without the other is a common and dangerous shortcut — a signed-only pipeline vouches for provenance while saying nothing about content; a scanned-only pipeline can be fed a tampered artifact.

## Sovereign by construction

All of this executes in the **deployer's** arc, in the deployer's tenant. The marketplace operator never holds the deployer's state **or their trust decision**. arc-as-trust-gate is #10 restated for distribution: the controls sit in the *deployer's* hands, not the publisher's. A blueprint that deployed onto the operator's substrate instead — recentralising everyone's infra on one account — is the exact failure mode the agentic-work thesis exists to avoid.

## What we are NOT

Consistent with the "What we refuse to become" list:

- **A gate the publisher can satisfy by assertion.** No control here accepts "I signed it, trust me" or "the manifest says so" — provenance is verified by math, capability by a deterministic diff.
- **An LLM as the install condition.** Model review is a filter/second opinion, never the receipt. The gate is deterministic (signature verify + scan + human-at-line).
- **A registry that holds your trust decision.** Verification is client-side, in the deployer's arc; the operator is not a trusted third party.

## Current state vs frontier

- **Have today:** source-based trust tiers; the capability manifest + install-time capability display; `cosign.ts` signing infrastructure; a deterministic content-scan engine (gitleaks + denylist + shape patterns) already gating this ecosystem's repos.
- **Frontier (design work):** (1) end-to-end **component signing + verify** wired into the arc install path (verify signature before symlinking, tier × signature-validity as the composed posture); (2) the **declared-vs-actual capability diff** — the "unforgeable" half of the scan that checks code reach against the manifest; (3) the **receipt + append-only install log**; (4) the **human-at-the-line** policy table (per PRINCIPLES #8/#11 — the auto/propose/approve mapping the installing agent inherits and cannot edit).

## Open questions

1. Where is the signature root of trust — per-publisher keys (keyless Sigstore/OIDC identities) vs a metafactory keyring? Revocation flow.
2. Capability-diff fidelity: how much of "actual reach" can be checked deterministically (imports/syscalls/network) before it becomes a model judgement (which, per #12, can only advise)?
3. Does the receipt log warrant an independent observer process (never the installing agent — #10/"a system that audits itself"), and when does it earn its keep?
4. Per-install grants (raise the posture for one install, logged, one-way) vs standing per-tier policy — or both.
