/**
 * Shared `{{TOKEN}}` substitution helper for OS-supervision host templates
 * (macOS launchd plists, Linux systemd units). Extracted from
 * launchd-install.ts's `renderPlist` (arc#311) so both hosts share ONE
 * implementation of the marker grammar instead of forking it.
 *
 * Permissive on unknown tokens: a `{{FOO}}` whose key is not in `tokens`
 * is preserved verbatim in the output. This lets a bot package use custom
 * markers that its own lifecycle script resolves (e.g. before
 * `launchctl bootstrap` on darwin, or via a unit `ExecStartPre=` on linux).
 *
 * The marker grammar accepts `[A-Za-z0-9_-]+` so hyphenated token names
 * (e.g. `{{LOG-DIR}}`, `{{ai-meta-factory}}`) substitute too. Sage P3
 * review (arc#143): the original `\w` class silently passed hyphenated
 * markers through unsubstituted even when present in the tokens map.
 */
export type TokenMap = Record<string, string>;

export function renderTokens(template: string, tokens: TokenMap): string {
  return template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (match, key: string) => {
    return key in tokens ? tokens[key] : match;
  });
}
