/**
 * provides-target — resolve a manifest `provides.files[].target` to an absolute
 * host path, expanding a leading `~` and the XDG placeholder tokens.
 *
 * #287 (P2) adds the `{bin}` token so a package can declare *intent* — "land
 * this on the user's PATH" — instead of hard-coding `~/.local/bin` (which is
 * wrong on a box where `~/bin` is the PATH dir, or under a custom `$XDG_*`
 * layout). `{bin}` resolves to `xdg-paths.binDir()` (the same shared resolver
 * arc uses for its own CLI shims): `~/.local/bin` or `~/bin` when already on
 * `$PATH`, else `~/.local/bin`.
 *
 * The three class tokens `{data}` / `{state}` / `{cache}` resolve to the arc
 * suite-app XDG roots (`…/metafactory/arc`) for packages that want to drop
 * durable / transient / regenerable files in the conventional place. `{config}`
 * resolves to the arc config root.
 *
 * The `{cortex-config}` token (G-18, cortex#1867) is DISTINCT from `{config}`:
 * it resolves to the LIVE cortex config dir via the existence-gated
 * {@link resolveCortexConfigDir} (canonical `~/.config/metafactory/cortex` on a
 * migrated box, else the legacy trees) — NOT arc's own `metafactory/arc` root.
 * Agent-pack manifests use it (`{cortex-config}/agents.d/<id>.yaml`) so their
 * identity fragments drop into the tree the running cortex actually reads.
 *
 * This helper is used at EVERY provides.files site (install, verify, upgrade,
 * remove) so the path a package is installed to and the path it is removed from
 * are computed identically — a divergence would orphan files. Keep it the single
 * source of truth.
 */

import { homedir } from "os";
import {
  binDir as xdgBinDir,
  dataDir as xdgDataDir,
  stateDir as xdgStateDir,
  cacheDir as xdgCacheDir,
  configDir as xdgConfigDir,
  type XdgSeam,
} from "./xdg-paths.js";
import { resolveCortexConfigDir } from "./hosts/cortex-config-dir.js";

/** arc's XDG suite-app namespace (kept in sync with `paths.ts` `ARC_APP`). */
const ARC_APP = "arc";

/**
 * Resolve a `provides.files` target. Expands (in this order) the `{bin}`,
 * `{data}`, `{state}`, `{cache}`, `{config}` tokens, then a leading `~`.
 * Token values honor `$XDG_*` / `$PATH` via the shared xdg-paths resolver; the
 * optional `seam` lets tests inject `{home, env, platform}`.
 */
export function resolveProvidesTarget(target: string, seam?: XdgSeam): string {
  const home = seam?.home ?? homedir();

  let out = target;
  if (out.includes("{bin}")) out = out.replaceAll("{bin}", xdgBinDir(seam));
  if (out.includes("{data}")) out = out.replaceAll("{data}", xdgDataDir(ARC_APP, seam));
  if (out.includes("{state}")) out = out.replaceAll("{state}", xdgStateDir(ARC_APP, seam));
  if (out.includes("{cache}")) out = out.replaceAll("{cache}", xdgCacheDir(ARC_APP, seam));
  // `{cortex-config}` is resolved BEFORE `{config}` for clarity; the two never
  // collide as substrings (`{config}` requires `{` immediately before `config`,
  // which `{cortex-config}` lacks). It routes to the LIVE cortex config dir, not
  // arc's own — see the module header.
  if (out.includes("{cortex-config}"))
    out = out.replaceAll("{cortex-config}", resolveCortexConfigDir(seam));
  if (out.includes("{config}")) out = out.replaceAll("{config}", xdgConfigDir(ARC_APP, seam));

  return out.replace(/^~/, home);
}
