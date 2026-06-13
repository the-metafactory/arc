import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type {
  ArtifactType,
  CortexHostPaths,
  HostAdapter,
} from "../../types.js";

/**
 * Cortex host adapter.
 *
 * Hosts agent identity fragments (`agents.d/<id>.yaml`), persona files
 * (`~/.config/cortex/personas/<id>.md`), and per-agent NATS creds files
 * (`~/.config/nats/creds/<id>.creds`). Cortex does NOT host skills, prompts,
 * or tools — those belong to a claude-code or codex host.
 *
 * Detection: a cortex install is recognized by the presence of
 * `~/.config/cortex/cortex.yaml` at `paths.settingsPath`. This matches the
 * cross-platform `existsSync` strategy used by `claude-code.ts` — no shell
 * spawn, works identically on Windows / macOS / Linux. The NATS health probe
 * envisioned in `docs/design-arc-agent-bots.md` §6.2 and a `cortex`-binary-
 * on-PATH probe are both deferred: the former is too heavy for a sync
 * `detect()`, the latter requires a platform-specific implementation
 * (`/bin/sh -c "command -v …"` is POSIX-only). Operators on a fresh install
 * without `cortex.yaml` yet can run `cortex init` to materialize the file.
 *
 * See cortex `docs/design-arc-agent-bots.md` §6.2 for the full design
 * rationale. Bot packs (an `agent.yaml` at the pack root) are dropped by
 * `artifact-installer.ts` as `agents.d/<id>.yaml` + `personas/<id>.md`; the
 * §8.1 post-install side effects (`cortex agents reload`, then
 * `cortex creds issue <id>`) ride the PACK's `lifecycle.postinstall` scripts,
 * which install() runs after the drop — arc never hardcodes cortex CLI calls
 * (cortex#1021 W-4).
 */

export interface CortexHostOptions {
  /** Cortex config root (default: ~/.config/cortex). */
  configRoot?: string;
  /**
   * Directory where the cortex daemon writes per-agent NATS creds
   * (default: ~/.config/nats/creds). Kept separate from `configRoot`
   * because NATS clients expect creds at the NATS-conventional location.
   */
  credsRoot?: string;
}

/** Build cortex host paths rooted at the given config root + creds root. */
export function cortexPaths(opts?: CortexHostOptions): CortexHostPaths {
  const configRoot = opts?.configRoot ?? join(homedir(), ".config", "cortex");
  const credsRoot =
    opts?.credsRoot ?? join(homedir(), ".config", "nats", "creds");
  return {
    root: configRoot,
    // Cortex is not a skills host — skillsDir stays empty so a caller that
    // bridges `supports()` to a path lookup gets an obviously-broken value
    // instead of a plausibly-wrong one. `supports("skill") === false` is the
    // truthful gate; `hostPathFor(host, "skill")` returning `""` here is
    // defensive belt-and-suspenders.
    skillsDir: "",
    agentsDir: join(configRoot, "agents.d"),
    // Cortex doesn't host slash commands or operator binaries; both are empty
    // for the same reason as skillsDir.
    promptsDir: "",
    binDir: "",
    settingsPath: join(configRoot, "cortex.yaml"),
    // Cortex-only extensions:
    personasDir: join(configRoot, "personas"),
    credsDir: credsRoot,
  };
}

export function createCortexHost(opts?: CortexHostOptions): HostAdapter & {
  paths: CortexHostPaths;
} {
  const paths = cortexPaths(opts);
  return {
    id: "cortex",
    paths,
    detect: () => existsSync(paths.settingsPath),
    supports: (type: ArtifactType) => type === "agent",
  };
}
