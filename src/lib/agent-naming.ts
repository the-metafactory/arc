/**
 * agent-naming.ts — shared agent-id grammar + display-name formatting.
 *
 * Single source of truth for the canonical agent-name rules, imported by both
 * `src/commands/identity.ts` (signing-key generation) and
 * `src/lib/identity-provision.ts` (F-6b install-time provisioning) so the two
 * paths can never drift on what a valid agent id is or how a display name is
 * derived from it.
 */

/**
 * Canonical agent-id / bot-name grammar: lowercase alphanumeric with single
 * internal hyphens — no leading, trailing, or consecutive hyphens. Also blocks
 * path-traversal characters (`/`, `.`, `\`) by construction, since a malformed
 * id would otherwise be interpolated into NKey/state paths.
 */
export const AGENT_ID_RE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/** Title-case a hyphenated agent id into a human-readable display name. */
export function formatDisplayName(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
