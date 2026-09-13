/**
 * The current user's home directory, resolved AT CALL TIME.
 *
 * Why this exists (arc#421 round 2, M1 — the "read-from-real-home" class):
 *
 * `os.homedir()` DOES honour `$HOME` when it is set at process spawn. What it
 * does NOT honour is an in-process mutation of `process.env.HOME` after the
 * process has started — Bun resolves the value once and caches it. A module
 * that computes a home-rooted constant at MODULE LOAD compounds the problem:
 * by the time a test's `beforeAll` sets any override, the constant is already
 * baked, and every write lands in the operator's real home.
 *
 * That is not a hypothetical: a plain `bun test` on this repo wrote 25
 * `agents/*.provision.json` sidecars, `principals.json` entries, a `keys/`
 * tree, `~/.config/cortex/agents/`, and a `~/.config/nats/*.creds` file into
 * the real home of the machine running it — overwriting several of the
 * operator's own agents in the process.
 *
 * So: resolve home per call, preferring `process.env.HOME` (which a test can
 * pin in-process) and falling back to `os.homedir()`. In production the two
 * agree — `os.homedir()` reads `$HOME` on POSIX — so this changes no real
 * behaviour; it only makes the value SANDBOXABLE. Precedent in this codebase:
 * `src/lib/hooks.ts` has resolved home exactly this way since arc#137.
 *
 * Prefer an explicit injected root where one is already threaded (an
 * `ArcPaths`, a `PathSeam`, an `XdgSeam`). Use this only at the leaf sites
 * that have no seam to thread.
 */
import { homedir } from "node:os";

export function userHome(): string {
  const fromEnv = process.env.HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : homedir();
}
