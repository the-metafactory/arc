import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { execSync } from "child_process";
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
 * Detection: a cortex install is recognized when `~/.config/cortex/cortex.yaml`
 * exists OR a `cortex` binary is on PATH. The NATS health probe envisioned in
 * `docs/design-arc-agent-bots.md` §6.2 is deferred — too heavy for sync
 * `detect()`, flaky in CI, and config-file presence already covers v1.
 *
 * See cortex `docs/design-arc-agent-bots.md` §6.2 for the full design
 * rationale and the post-install side effects (`cortex agents reload`,
 * `cortex creds issue`) that land in a follow-up once arc exposes per-adapter
 * install hooks.
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
  /**
   * Override the cortex-binary-on-PATH check used by `detect()`. Useful in
   * tests that want to assert config-file-only detection without depending
   * on the dev host's actual PATH.
   */
  cortexOnPath?: () => boolean;
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

function defaultCortexOnPath(): boolean {
  try {
    execSync("command -v cortex", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createCortexHost(opts?: CortexHostOptions): HostAdapter & {
  paths: CortexHostPaths;
} {
  const paths = cortexPaths(opts);
  const cortexOnPath = opts?.cortexOnPath ?? defaultCortexOnPath;
  return {
    id: "cortex",
    paths,
    detect: () => existsSync(paths.settingsPath) || cortexOnPath(),
    supports: (type: ArtifactType) => type === "agent",
  };
}
