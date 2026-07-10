/**
 * Minimal semver comparison + range satisfaction — no external dependency
 * (arc keeps its dependency footprint deliberately small; see package.json).
 *
 * Supports the subset of range syntax actually used across the manifest
 * schema today: `SkillDependency.version` / `ToolDependency.version`
 * (`depends_on.skills[].version`, `depends_on.tools[].version`) and
 * `AgentState.version` — all documented as plain semver or a range like
 * ">=1.0.0" / "^1" / "~1.2.0". A range is one or more whitespace-separated
 * clauses, ALL of which must hold (AND semantics; there is no OR/`||`
 * support, since no documented field uses it).
 */

export type SemverTuple = readonly [number, number, number];

/** Parse "1.2.3" (or "1", "1.2") into a [major, minor, patch] tuple. Missing
 * components default to 0. Non-numeric input parses as [0, 0, 0] — callers
 * comparing against an unparsable version will treat it as least-recent
 * rather than throwing, since a malformed installed version shouldn't crash
 * the compat check. */
export function parseVersion(version: string): SemverTuple {
  // Strip a leading "v" (e.g. "v1.2.3") and any prerelease/build metadata
  // (e.g. "1.2.3-beta.1", "1.2.3+build5") — those aren't compared here.
  const core = version.trim().replace(/^v/, "").split(/[-+]/)[0] ?? "";
  const parts = core.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const;
}

/** Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** Compute the exclusive upper bound for a caret (`^`) range, npm semantics:
 * `^1.2.3` → `<2.0.0`; `^0.2.3` → `<0.3.0`; `^0.0.3` → `<0.0.4`. */
function caretUpperBound([major, minor, patch]: SemverTuple): SemverTuple {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

/** Compute the exclusive upper bound for a tilde (`~`) range: `~1.2.3` →
 * `<1.3.0`; `~1.2` / `~1` → `<2.0.0` (bare major/minor bumps that segment). */
function tildeUpperBound(version: string, [major, minor]: SemverTuple): SemverTuple {
  const segments = version.trim().replace(/^v/, "").split(".").length;
  if (segments < 2) return [major + 1, 0, 0];
  return [major, minor + 1, 0];
}

function tupleToString([major, minor, patch]: SemverTuple): string {
  return `${major}.${minor}.${patch}`;
}

// Longest-prefix-first so ">=" is tried before ">" (and "<=" before "<").
const RANGE_OPERATORS = [">=", "<=", ">", "<", "^", "~", "="] as const;
type RangeOperator = (typeof RANGE_OPERATORS)[number];

/** Evaluate a single range clause (e.g. "^1.2.0", ">=1.0.0", "1.2.3")
 * against a parsed version. A bare version (no prefix) is treated as "=". */
function satisfiesClause(version: string, clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return true;

  const matchedOp = RANGE_OPERATORS.find((candidate) => trimmed.startsWith(candidate));
  const op: RangeOperator = matchedOp ?? "=";
  const target = (matchedOp ? trimmed.slice(matchedOp.length) : trimmed).trim();
  if (!target) return true; // unparsable clause — don't block on it

  const targetTuple = parseVersion(target);
  const cmp = compareVersions(version, target);

  switch (op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    case "^": {
      const upper = caretUpperBound(targetTuple);
      return cmp >= 0 && compareVersions(version, tupleToString(upper)) < 0;
    }
    case "~": {
      const upper = tildeUpperBound(target, targetTuple);
      return cmp >= 0 && compareVersions(version, tupleToString(upper)) < 0;
    }
    default:
      return true;
  }
}

/**
 * Does `version` satisfy `range`? Range is one or more whitespace-separated
 * clauses (AND semantics), e.g. ">=1.0.0 <2.0.0", "^1", "~1.2.0", "1.2.3".
 * An empty/unparsable range is treated as always-satisfied (nothing declared
 * to violate).
 */
export function satisfiesRange(version: string, range: string): boolean {
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.every((clause) => satisfiesClause(version, clause));
}
