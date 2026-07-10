/**
 * Minimal semver comparison + range satisfaction — no external dependency
 * (arc keeps its dependency footprint deliberately small; see package.json).
 *
 * Supports the subset of range syntax actually used across the manifest
 * schema today: `SkillDependency.version` / `ToolDependency.version`
 * (`depends_on.skills[].version`, `depends_on.tools[].version`) and
 * `AgentState.version` — documented as plain semver, an X-range (`*`, `1.x`,
 * `1.2.x`), a comparator (`>=1.0.0`, `^1`, `~1.2.0`), a space-separated AND
 * range (`>=1.0.0 <2.0.0`), or an OR range of the above joined with `||`
 * (`>=1.0.0 <2.0.0 || >=3.0.0`). Whitespace after a comparator operator
 * (`>= 1.0.0`) is accepted — it's legal npm range syntax and reads naturally
 * in YAML.
 *
 * FAIL-OPEN POSTURE (arc#289): every caller of `satisfiesRange` treats it as
 * advisory (a WARN, never a hard-fail — see install.ts). For an advisory
 * check, a false WARN (blocking a version that's actually compatible) is
 * worse than a missed one (staying silent on a range this module doesn't
 * understand) — a false WARN trains operators to ignore the channel. So:
 * an empty range, an empty/unparsable clause target, or a clause this parser
 * doesn't recognise ALL resolve to "satisfied" (`true`) rather than `false`
 * or a thrown error. `satisfiesRange` never throws.
 *
 * The one deliberate EXCEPTION to fail-open is pre-release handling, which
 * fails CLOSED by design (matching npm semver): a pre-release version
 * (`1.0.0-beta`) only satisfies a clause whose own target names a
 * pre-release on the same `[major, minor, patch]` tuple — e.g. a plugin
 * pinned to a released `cortex >=6.0.0` should NOT be told it's compatible
 * with an installed `cortex@7.0.0-rc.1` just because pre-release tags are
 * ignored. This module does not compare pre-release *identifiers* against
 * each other (e.g. "beta" vs "alpha" ordering) — presence + matching tuple
 * is enough for this advisory check.
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

/** Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Compares [major, minor, patch] only — pre-release/build metadata is
 * stripped (see parseVersion); pre-release-aware exclusion is handled
 * separately in satisfiesClause. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** The pre-release tag of a version string (the segment after the first
 * `-`, stopping before any `+build` metadata), or `null` when there isn't
 * one. `"1.2.3-beta.1"` -> `"beta.1"`; `"1.2.3"` -> `null`. */
function extractPrerelease(version: string): string | null {
  const stripped = version.trim().replace(/^v/, "");
  const dash = stripped.indexOf("-");
  if (dash === -1) return null;
  const afterDash = stripped.slice(dash + 1);
  const plus = afterDash.indexOf("+");
  const tag = plus === -1 ? afterDash : afterDash.slice(0, plus);
  return tag.length > 0 ? tag : null;
}

function tuplesEqual(a: SemverTuple, b: SemverTuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Segment count of a version string, ignoring a leading "v" but NOT
 * stripping prerelease/build metadata — used only by caret/tilde partial-
 * version detection, where a clause target is expected to be a plain
 * dotted-number string (e.g. "0", "0.2", "1.2.3"). */
function countVersionSegments(version: string): number {
  return version.trim().replace(/^v/, "").split(".").length;
}

/** Compute the exclusive upper bound for a caret (`^`) range, npm semantics:
 * `^1.2.3` -> `<2.0.0`; `^0.2.3` -> `<0.3.0`; `^0.0.3` -> `<0.0.4`.
 *
 * Caret-on-zero also depends on how MANY segments were specified (npm's
 * "missing segments are wildcards" rule): `^0` (major only) -> `<1.0.0`,
 * same as `^0.x`; `^0.0` (major+minor only) -> `<0.1.0`, same as `^0.0.x`;
 * only a fully-specified `^0.0.3` narrows to `<0.0.4`. */
function caretUpperBound(version: string, [major, minor, patch]: SemverTuple): SemverTuple {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  const segments = countVersionSegments(version);
  if (segments < 2) return [1, 0, 0]; // "^0" — minor/patch unspecified
  if (segments < 3) return [0, 1, 0]; // "^0.0" — patch unspecified
  return [0, 0, patch + 1];
}

/** Compute the exclusive upper bound for a tilde (`~`) range: `~1.2.3` ->
 * `<1.3.0`; `~1.2` / `~1` -> `<2.0.0` (bare major/minor bumps that segment). */
function tildeUpperBound(version: string, [major, minor]: SemverTuple): SemverTuple {
  const segments = countVersionSegments(version);
  if (segments < 2) return [major + 1, 0, 0];
  return [major, minor + 1, 0];
}

function tupleToString([major, minor, patch]: SemverTuple): string {
  return `${major}.${minor}.${patch}`;
}

function isWildcardToken(seg: string | undefined): boolean {
  return seg === undefined || seg === "" || seg === "*" || seg === "x" || seg === "X";
}

/** Does `core` (a clause target with no operator prefix and no
 * prerelease/build suffix) read as an X-range — `*`, `1`, `1.x`, `1.2`,
 * `1.2.x` — rather than a fully-specified exact version? */
function isXRangeClause(core: string): boolean {
  if (core === "*" || core === "") return true;
  const segs = core.split(".");
  if (segs.length < 3) return true;
  return segs.slice(0, 3).some((s) => isWildcardToken(s));
}

/** Compute the [floor, exclusive-ceiling] bounds of an X-range clause, npm
 * semantics: `*` -> unbounded (`ceil: null`); `1` / `1.x` -> `>=1.0.0
 * <2.0.0`; `1.2` / `1.2.x` -> `>=1.2.0 <1.3.0`. */
function xRangeBounds(core: string): { floor: SemverTuple; ceil: SemverTuple | null } {
  const segs = core.split(".");
  const explicit: number[] = [];
  let wildcardAt = -1;
  for (let i = 0; i < 3; i++) {
    const seg = segs[i];
    if (isWildcardToken(seg) || !/^\d+$/.test(seg)) {
      wildcardAt = i;
      break;
    }
    explicit.push(Number.parseInt(seg, 10));
  }
  if (wildcardAt === -1) {
    const floor: SemverTuple = [explicit[0] ?? 0, explicit[1] ?? 0, explicit[2] ?? 0];
    return { floor, ceil: floor };
  }
  if (wildcardAt === 0) return { floor: [0, 0, 0], ceil: null };
  if (wildcardAt === 1) return { floor: [explicit[0] ?? 0, 0, 0], ceil: [(explicit[0] ?? 0) + 1, 0, 0] };
  return {
    floor: [explicit[0] ?? 0, explicit[1] ?? 0, 0],
    ceil: [explicit[0] ?? 0, (explicit[1] ?? 0) + 1, 0],
  };
}

// Longest-prefix-first so ">=" is tried before ">" (and "<=" before "<").
const RANGE_OPERATORS = [">=", "<=", ">", "<", "^", "~", "="] as const;
type RangeOperator = (typeof RANGE_OPERATORS)[number];

/** Evaluate a clause's core logic (comparator match / X-range / exact),
 * IGNORING pre-release exclusion — satisfiesClause applies that uniformly
 * afterward so every branch (bare, X-range, and every operator) gets the
 * same pre-release posture without repeating it per-branch. */
function evaluateClauseCore(version: string, matchedOp: RangeOperator | undefined, target: string): boolean {
  if (!target) return true; // operator with no target, or bare "" — nothing to violate

  // Strip prerelease/build metadata for shape analysis (X-range vs exact vs
  // unparsable) — compareVersions/parseVersion below still see the full
  // `target` string so an exact clause like "1.0.0-beta" still compares
  // correctly against a same-tagged version.
  const targetCore = target.split(/[-+]/)[0] ?? "";

  if (!matchedOp) {
    if (isXRangeClause(targetCore)) {
      const { floor, ceil } = xRangeBounds(targetCore);
      if (ceil === null) return true; // "*"
      return (
        compareVersions(version, tupleToString(floor)) >= 0 &&
        compareVersions(version, tupleToString(ceil)) < 0
      );
    }
    const segs = targetCore.split(".");
    if (segs.length === 3 && segs.every((s) => /^\d+$/.test(s))) {
      return compareVersions(version, target) === 0;
    }
    return true; // unparsable bare clause — fail open, never throw
  }

  const targetTuple = parseVersion(target);
  const cmp = compareVersions(version, target);

  switch (matchedOp) {
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
      const upper = caretUpperBound(target, targetTuple);
      return cmp >= 0 && compareVersions(version, tupleToString(upper)) < 0;
    }
    case "~": {
      const upper = tildeUpperBound(target, targetTuple);
      return cmp >= 0 && compareVersions(version, tupleToString(upper)) < 0;
    }
  }
}

/** Evaluate a single range clause (e.g. "^1.2.0", ">=1.0.0", "1.2.3", "*",
 * "1.x") against `version`. A bare clause with no operator prefix is an
 * X-range when it names fewer than 3 segments or a `x`/`X`/`*` wildcard
 * segment, otherwise an exact-match. Applies the pre-release exclusion rule
 * uniformly across every branch — see the module docstring. */
function satisfiesClause(version: string, clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return true;

  const matchedOp = RANGE_OPERATORS.find((candidate) => trimmed.startsWith(candidate));
  const target = (matchedOp ? trimmed.slice(matchedOp.length) : trimmed).trim();

  const result = evaluateClauseCore(version, matchedOp, target);

  const versionPrerelease = extractPrerelease(version);
  if (versionPrerelease !== null) {
    const targetPrerelease = target ? extractPrerelease(target) : null;
    const sameTuple = target ? tuplesEqual(parseVersion(version), parseVersion(target)) : false;
    if (targetPrerelease === null || !sameTuple) return false;
  }

  return result;
}

// Collapses "<operator> <whitespace>" into "<operator>" so a spaced
// comparator (">= 1.0.0", legal npm syntax) tokenizes the same as an
// unspaced one. Anchored on (start-of-string | whitespace) before the
// operator so it never matches an operator character embedded elsewhere.
const OPERATOR_SPACE_RE = /(^|\s)(>=|<=|>|<|\^|~|=)\s+(?=\S)/g;

/** Evaluate one AND range-set (whitespace-separated clauses, all must hold)
 * — the unit `||` joins together in an OR range. */
function satisfiesRangeSet(version: string, rangeSet: string): boolean {
  const collapsed = rangeSet.replace(OPERATOR_SPACE_RE, "$1$2");
  const clauses = collapsed.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.every((clause) => satisfiesClause(version, clause));
}

/**
 * Does `version` satisfy `range`? A range is one or more `||`-separated
 * range-sets (OR semantics — satisfied if ANY set is satisfied); each
 * range-set is one or more whitespace-separated clauses (AND semantics —
 * ALL must hold), e.g. ">=1.0.0 <2.0.0", "^1", "~1.2.0", "1.2.3", "*",
 * "1.x", ">=1.0.0 <2.0.0 || >=3.0.0". An empty range, or a clause this
 * parser can't make sense of, is treated as satisfied — see the module
 * docstring for the fail-open rationale and the pre-release exception.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmedRange = range.trim();
  if (!trimmedRange) return true;
  const orGroups = trimmedRange
    .split("||")
    .map((group) => group.trim())
    .filter(Boolean);
  if (orGroups.length === 0) return true;
  return orGroups.some((group) => satisfiesRangeSet(version, group));
}
