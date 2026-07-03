# Arc Context

Arc installs, upgrades, verifies, and publishes agentic packages while preserving trust, host placement, and rollback invariants.

## Language

**Install Transaction**:
The all-or-nothing package operation that turns a resolved package artifact into landed host artifacts plus a committed package database row.
_Avoid_: Artifact landing, install pipeline, install flow

**Resolved Package**:
A package whose source, version, manifest location, and install material have been determined before installation begins.
_Avoid_: Lookup result, found package

**Install Authorization**:
A decision that the package is allowed to land after trust, capability, and operator policy checks have completed.
_Avoid_: Approval flag, yes option, confirmation

**Landed Artifact**:
A host-visible package output such as a skill symlink, command shim, hook registration, extension wiring, launchd plist, or generated template.
_Avoid_: Installed file, output

**Soma Projection**:
A best-effort postinstall handoff where Arc asks Soma to project or unproject a skill into Soma-owned substrates after Arc has landed the package. Successful projection may be recorded as a **Landed Artifact**; failed, timed-out, or unavailable Soma projection remains non-fatal and is reported as warning/rollback cleanup state rather than committed package state.
_Avoid_: Soma install, Arc-owned substrate sync

**Transaction Evidence**:
The structured record of what an Install Transaction landed, committed, rolled back, or failed to roll back.
_Avoid_: Result object, debug details

## Relationships

- An **Install Transaction** starts from exactly one **Resolved Package**.
- An **Install Transaction** requires exactly one **Install Authorization** before landing artifacts.
- An **Install Transaction** may create many **Landed Artifacts**.
- An **Install Transaction** may delegate a skill **Soma Projection** after package lifecycle checks; Soma owns projection into its substrates.
- An **Install Transaction** returns **Transaction Evidence** whether it succeeds or fails.
- A package database row is committed only after the **Install Transaction** has landed artifacts and completed lifecycle checks.

## Example Dialogue

> **Dev:** "Should `arc upgrade` reuse the **Install Transaction**?"
> **Domain expert:** "Only for the part that lands the new package state; source update and version selection can stay outside."

> **Dev:** "Should the **Install Transaction** ask for permission?"
> **Domain expert:** "No — it receives an **Install Authorization** after the caller has handled trust and capability review."

> **Dev:** "Should rollback warnings only be printed?"
> **Domain expert:** "No — they belong in **Transaction Evidence** so tests and callers can inspect the outcome."

## Flagged Ambiguities

- "install flow" was used for both source resolution and artifact landing; resolved: **Install Transaction** begins after package resolution and owns landing plus commit/rollback.
- "`--yes`" was used as if it were the approval model; resolved: `--yes` is one way to produce an **Install Authorization**, not the domain concept itself.
- "result" was used for both user-facing command output and internal rollback facts; resolved: **Transaction Evidence** is the internal install record, while CLI formatting remains separate.
