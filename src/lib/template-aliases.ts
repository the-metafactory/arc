/**
 * Which `template:` spellings a rules package answers to (arc#423 MAJOR 2).
 *
 * ## Why a set, and not a stem
 *
 * The first cut of the arc#423 write-authority gate matched a consumer's
 * `template:` against the package name by STEM — `split("-")[0]`. That accepts
 * the three live spellings, and it also accepts every other string sharing the
 * first segment: `template: compass-evil` was authority for package `compass`.
 * A gate whose whole job is "did this repo name THIS package" cannot answer yes
 * to a package it was never shown. Matching is now exact, against an explicit
 * set of names.
 *
 * ## Where the set lives
 *
 * The providing package is the authority on what it is called, so the durable
 * home is its own manifest: `provides.templateAliases`. A package that has ever
 * been referred to by a second name declares it there, and arc needs no
 * knowledge of any particular package.
 *
 * `BUILTIN_TEMPLATE_ALIASES` is the migration shim for the one package that
 * predates the field. compass ships templates that three live repos already
 * declare under two older spellings (crucible says `compass-core`; cortex and
 * halden say `compass-standards`), written before anything read the field at
 * all. Dropping them would refuse every real consumer — the feature the gate
 * exists to protect. The entry retires the moment compass's manifest declares
 * `provides.templateAliases`, because a declaration wins outright over the shim.
 */

import { canonicalMemberKey } from "./composition-identity.js";

/**
 * Compatibility aliases for packages published before
 * `provides.templateAliases` existed. Keyed by canonical package name.
 *
 * Additions here are a last resort: the package should declare its own.
 */
export const BUILTIN_TEMPLATE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  compass: ["compass", "compass-core", "compass-standards"],
};

/**
 * The canonical names `packageName` answers to as a template provider.
 *
 * A manifest declaration REPLACES the built-in shim rather than adding to it:
 * a package that has stated its own names has stated all of them, and silently
 * unioning a hard-coded list back in would put arc's opinion above the
 * package's own.
 */
export function templateAliasSet(
  packageName: string,
  declared?: readonly string[],
): Set<string> {
  const canonical = canonicalMemberKey(packageName);
  const extra =
    declared && declared.length > 0 ? declared : (BUILTIN_TEMPLATE_ALIASES[canonical] ?? []);
  const set = new Set<string>();
  for (const name of [packageName, ...extra]) {
    const key = canonicalMemberKey(name);
    if (key) set.add(key);
  }
  return set;
}
