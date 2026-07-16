import { describe, test, expect } from "bun:test";
import { VALID_TYPES } from "../../src/lib/validate-manifest.js";
import { INSTALLABLE_ARTIFACT_TYPES } from "../../src/lib/artifact-installer.js";

/**
 * Validator↔installer TYPE-SET parity invariant (arc#334) — the twin of the
 * validator↔loader network-shape parity in test/validate/fixtures.test.ts
 * (arc#335). Both guard the same failure mode: a manifest that the strict
 * validator (and CI) accept but `arc install` cannot handle.
 *
 * The strict validator's accepted `type` set MUST equal the set of types arc
 * can actually install. Before arc#334 the validator accepted `type: bundle`
 * while the installer had no `bundle` case, so a bundle manifest validated green
 * yet threw `Unsupported artifact type "bundle"` at install. Decision (b):
 * `bundle` is dropped from the validator (it is a repo-name class, not a
 * manifest type). This test fails the moment the two sets drift again.
 */
describe("arc#334 — validator↔installer type-set parity", () => {
  test("VALID_TYPES (validator) === INSTALLABLE_ARTIFACT_TYPES (installer)", () => {
    const validator = [...VALID_TYPES].sort();
    const installer = [...INSTALLABLE_ARTIFACT_TYPES].sort();
    expect(validator).toEqual(installer);
  });

  test("no validator type is un-installable (every validated type has installer support)", () => {
    const installer = new Set<string>(INSTALLABLE_ARTIFACT_TYPES);
    const unsupported = VALID_TYPES.filter((t) => !installer.has(t));
    expect(unsupported).toEqual([]);
  });

  test("no installer type is un-validatable (every installable type is accepted by the validator)", () => {
    const validator = new Set<string>(VALID_TYPES);
    const unvalidated = INSTALLABLE_ARTIFACT_TYPES.filter((t) => !validator.has(t));
    expect(unvalidated).toEqual([]);
  });

  test("'bundle' is neither validated nor installable — it is a repo-name class", () => {
    expect((VALID_TYPES as readonly string[]).includes("bundle")).toBe(false);
    expect((INSTALLABLE_ARTIFACT_TYPES as readonly string[]).includes("bundle")).toBe(false);
  });
});
