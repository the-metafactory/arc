import { join, dirname } from "path";
import { existsSync, readdirSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { readFileSync } from "fs";
import YAML from "yaml";
import type {
  ArtifactType,
  ArcManifest,
  ArcPaths,
  CortexHostPaths,
  HostAdapter,
  LibraryArtifactEntry,
} from "../types.js";
import { errorMessage, isErrno } from "./errors.js";
import {
  createSymlink,
  createCliShim,
  extractAllCliInfo,
  isValidSymlink,
  removeSymlink,
  removeCliShim,
} from "./symlinks.js";
import { generateRules } from "./rules.js";
import { requireHostDir } from "./hosts/dispatch.js";
import { resolveHost, type HostOverrides } from "./hosts/registry.js";

/**
 * Maps an artifact type to its conventional source subdirectory within a cloned repo.
 *
 * - rules, component, tool -> baseDir (no subdirectory)
 * - pipeline -> join(baseDir, "pipeline") if it exists, else baseDir
 * - agent -> join(baseDir, "agent")
 * - prompt -> join(baseDir, "prompt")
 * - skill (default) -> join(baseDir, "skill")
 */
export function resolveArtifactSourceDir(type: ArtifactType | "rules" | "system", baseDir: string): string {
  switch (type) {
    case "action":
    case "rules":
    case "component":
    case "tool":
      return baseDir;

    case "pipeline": {
      const pipelineDir = join(baseDir, "pipeline");
      return existsSync(pipelineDir) ? pipelineDir : baseDir;
    }

    case "agent":
      return join(baseDir, "agent");

    case "prompt":
      return join(baseDir, "prompt");

    case "skill":
    case "system":
    default:
      return join(baseDir, "skill");
  }
}

/**
 * Create symlinks for an installed artifact based on its type.
 *
 * Handles all artifact types: rules (template generation), pipeline, component,
 * tool, agent, prompt, and skill. Extracted from install() to allow reuse
 * across install, catalog use, and single-artifact install flows.
 */
/**
 * Aggregate of every filesystem artifact a single createArtifactSymlinks call
 * created. Captured so a downstream failure (hook gate, post-install script,
 * etc.) can roll back the partial state — see issue #89.
 */
export interface ArtifactSymlinkRecord {
  /** Absolute paths of symlinks created (any directory). */
  symlinks: string[];
  /** CLI shim files created via createCliShim (need removeCliShim, not unlink). */
  shims: { dir: string; names: string[] };
}

/** Common option shape shared by the planner and the apply step. */
export interface ArtifactSymlinkOpts {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Target host adapter. Defaults to Claude-Code in the caller. */
  host: HostAdapter;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}

/** A single symlink the install will create: `source` linked at `target`. */
export interface PlannedSymlink {
  source: string;
  target: string;
}

/**
 * The pure, write-free PLAN of what createArtifactSymlinks would drop for a
 * given artifact + host. Extracted (arc#248) so the install-time path
 * computation lives in ONE place. Two callers consume it:
 *   - createArtifactSymlinks (the APPLY step) turns the plan into real symlinks
 *     + shims (and runs the `rules` template-generation side effect, which has
 *     no symlink target and is invisible to the plan).
 *   - artifactDropPresent (the VERIFY step) checks each planned target actually
 *     exists on disk, so the DB-active skip-guard can be gated on
 *     filesystem-truth instead of blindly trusting the DB row.
 *
 * Re-deriving (vs. persisting) mirrors `arc verify` (src/commands/verify.ts),
 * which re-computes the expected skill symlink path rather than reading a
 * symlinks column the DB does not have.
 *
 * NOTE: planning READS the disk (to pick a source dir, detect the cortex
 * bot-pack agent.yaml shape, read the fragment id) but never WRITES. The reads
 * are the same branch decisions the apply step makes, so the two stay in
 * lock-step (the planner-parity test enforces target-set equality).
 */
export interface ArtifactSymlinkPlan {
  /** Symlink targets: primary per-type links + provides.files links. */
  symlinkTargets: PlannedSymlink[];
  /** Logical CLI shim names that will be written into `arc.shimDir`. */
  shimNames: string[];
  /**
   * provides.files entries whose source is MISSING in the package. When
   * non-empty the apply step aborts before mutating the filesystem (#84/#89).
   */
  filesMissingSource: PlannedSymlink[];
}

/**
 * Compute -- WITHOUT touching the filesystem -- every symlink + shim a
 * createArtifactSymlinks call would create for `opts`. Single source of truth
 * for the per-type install path logic; never writes.
 */
export function planArtifactSymlinks(opts: ArtifactSymlinkOpts): ArtifactSymlinkPlan {
  const { type, manifest, arc, host, installDir } = opts;
  const symlinkTargets: PlannedSymlink[] = [];
  const shimNames: string[] = [];

  // Pre-validation pass (#89): assert every provides.files source exists in
  // the package. The apply step bails here with zero filesystem mutation.
  const declaredFiles = manifest.provides?.files ?? [];
  const filesMissingSource: PlannedSymlink[] = [];
  for (const file of declaredFiles) {
    const sourcePath = join(installDir, file.source);
    if (!existsSync(sourcePath)) {
      filesMissingSource.push({
        source: sourcePath,
        target: file.target.replace(/^~/, homedir()),
      });
    }
  }
  if (filesMissingSource.length) {
    return { symlinkTargets: [], shimNames: [], filesMissingSource };
  }

  const shimNamesFor = (): string[] => extractAllCliInfo(manifest).map((e) => e.binName);

  switch (type) {
    case "action": {
      symlinkTargets.push({ source: installDir, target: join(arc.actionsDir, manifest.name) });
      break;
    }

    case "rules": {
      // Rules packages produce no symlink target -- they generate templates
      // into the consumer repo (done only in the apply step). Nothing to plan.
      break;
    }

    case "pipeline": {
      const pipelineSourceDir = join(installDir, "pipeline");
      const sourceDir = existsSync(pipelineSourceDir) ? pipelineSourceDir : installDir;
      symlinkTargets.push({ source: sourceDir, target: join(arc.pipelinesDir, manifest.name) });

      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        symlinkTargets.push({ source: installDir, target: join(host.paths.binDir, entry.binName) });
      }
      if (cliEntries.length) {
        shimNames.push(...shimNamesFor());
      }
      break;
    }

    case "component": {
      // No per-type primary layout -- provides.files only (handled below).
      break;
    }

    case "tool": {
      const binDir = requireHostDir(host, "tool");
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        symlinkTargets.push({ source: installDir, target: join(binDir, entry.binName) });
      }
      if (!cliEntries.length) {
        symlinkTargets.push({ source: installDir, target: join(binDir, manifest.name) });
      }
      shimNames.push(...shimNamesFor());
      break;
    }

    case "agent": {
      const botPackFragment = join(installDir, "agent.yaml");
      // Bot-pack branch needs BOTH a cortex host target AND the agent.yaml
      // shape at the pack root (cortex is today the only host with a
      // fragment/persona contract). Otherwise fall through to the legacy .md.
      if (host.id === "cortex" && existsSync(botPackFragment)) {
        const cortexPaths = host.paths as CortexHostPaths;
        const agentId = resolveBotPackAgentId(botPackFragment, manifest.name);
        symlinkTargets.push({
          source: botPackFragment,
          target: join(cortexPaths.agentsDir, `${agentId}.yaml`),
        });
        const personaPath = join(installDir, "persona.md");
        if (existsSync(personaPath)) {
          symlinkTargets.push({
            source: personaPath,
            target: join(cortexPaths.personasDir, `${agentId}.md`),
          });
        }
        break;
      }

      const agentsDir = requireHostDir(host, "agent");
      const agentSourceDir = join(installDir, "agent");
      const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      if (existsSync(sourcePath)) {
        symlinkTargets.push({ source: sourcePath, target: join(agentsDir, mdFile) });
      } else {
        symlinkTargets.push({ source: sourceDir, target: join(agentsDir, manifest.name) });
      }
      break;
    }

    case "prompt": {
      const promptsDir = requireHostDir(host, "prompt");
      const promptSourceDir = join(installDir, "prompt");
      const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      if (existsSync(sourcePath)) {
        symlinkTargets.push({ source: sourcePath, target: join(promptsDir, mdFile) });
      } else {
        symlinkTargets.push({ source: sourceDir, target: join(promptsDir, manifest.name) });
      }
      break;
    }

    case "skill":
    case "system": {
      const skillsDir = requireHostDir(host, type);
      const skillSourceDir = join(installDir, "skill");
      const sourceDir = existsSync(skillSourceDir) ? skillSourceDir : installDir;
      symlinkTargets.push({ source: sourceDir, target: join(skillsDir, manifest.name) });

      const cliEntries = extractAllCliInfo(manifest);
      if (cliEntries.length) {
        const binDir = requireHostDir(host, "tool", "expose a bin directory for skill CLIs");
        for (const entry of cliEntries) {
          symlinkTargets.push({ source: installDir, target: join(binDir, entry.binName) });
        }
        shimNames.push(...shimNamesFor());
      }
      break;
    }

    default: {
      throw new Error(
        `Unsupported artifact type "${type as string}" in planArtifactSymlinks`,
      );
    }
  }

  // Type-agnostic provides.files pass -- every type honors provides.files (#84).
  for (const file of declaredFiles) {
    symlinkTargets.push({
      source: join(installDir, file.source),
      target: file.target.replace(/^~/, homedir()),
    });
  }

  return { symlinkTargets, shimNames, filesMissingSource: [] };
}

/**
 * Resolve the cortex bot-pack agent id (filename stem) from the fragment's
 * `id:` field, falling back to the manifest name -- IDENTICAL logic to
 * linkCortexBotPackSymlinks, shared so the planner and the apply step agree on
 * where the fragment + persona land. Throws on a present-but-unsafe id (sage
 * arc#238 round 2) so the planner surfaces the same error the apply step would,
 * rather than silently planning a different target.
 */
function resolveBotPackAgentId(fragmentPath: string, manifestName: string): string {
  const rawId = readRawAgentFragmentId(fragmentPath);
  if (rawId !== undefined) {
    const agentId = sanitizeAgentId(rawId);
    if (agentId === undefined) {
      throw new Error(
        `agent pack "${manifestName}": agent.yaml declares an unsafe id "${rawId}" ` +
          `-- an id is a filename stem under agents.d/ (alphanumeric start, ` +
          `[a-z0-9._-], no "..", <=128 chars). Refusing to install.`,
      );
    }
    return agentId;
  }
  const agentId = sanitizeAgentId(manifestName.toLowerCase());
  if (agentId === undefined) {
    throw new Error(
      `agent pack "${manifestName}": agent.yaml has no usable id and the manifest ` +
        `name is not a safe filename stem -- refusing to install.`,
    );
  }
  return agentId;
}

/**
 * Verify that the host-side DROP for an artifact actually exists on disk
 * (arc#248). Re-derives the expected targets via planArtifactSymlinks, honoring
 * `manifest.targets` exactly as installPerTarget does (resolve each declared
 * HostId through resolveHost), else the single fallback host. Each primary
 * symlink target is checked with isValidSymlink; each provides.files target
 * with existsSync (it may be a symlink OR a copied file -- presence is what
 * matters).
 *
 * Returns false if ANY expected target is missing -- the DB row claims the
 * artifact is installed but the filesystem disagrees, so a skip-on-active guard
 * must NOT honor the skip (it would be a silent no-op reinstall).
 *
 * SCOPE (v1): launchd plist presence for darwin-launchd / linux-systemd targets
 * is NOT checked -- those targets are skipped here. The failure mode arc#248
 * documents is the symlink/fragment drop diverging from the DB; the
 * supervision-host side is a follow-up. The symlink/fragment drops on registry
 * hosts (cortex, claude-code) are the load-bearing check.
 *
 * KNOWN v1 LIMITATION (consequence of the above): a manifest whose `targets`
 * is ONLY supervision hosts (e.g. `targets: [darwin-launchd]`) resolves to an
 * EMPTY host list here, so the verify loop runs zero checks and returns
 * `true` UNCONDITIONALLY -- a wiped plist reads as "present". This is the
 * narrow false-positive the supervision-host follow-up will close (check plist
 * presence for those targets). Until then, a launchd-only artifact whose plist
 * was wiped will still be skipped on reinstall. Registry-host targets (the
 * arc#248 case) are unaffected.
 */
export async function artifactDropPresent(opts: {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Fallback host when the manifest declares no `targets`. */
  host: HostAdapter;
  installDir: string;
  hostOverrides?: HostOverrides;
}): Promise<boolean> {
  // `rules` packages drop no host symlink (templates land in the consumer repo
  // and aren't tracked per-host), so there is nothing to verify -- treat as
  // present so the skip-guard keeps its prior behavior for rules.
  if (opts.type === "rules") return true;

  const declaredFileTargets = new Set(
    (opts.manifest.provides?.files ?? []).map((f) => f.target.replace(/^~/, homedir())),
  );

  // Resolve the set of hosts the drop lands on -- mirror installPerTarget.
  const hosts: HostAdapter[] = [];
  if (opts.manifest.targets && opts.manifest.targets.length > 0) {
    for (const targetId of opts.manifest.targets) {
      // launchd/systemd are out of scope for v1 (see doc comment); skip them.
      if (targetId === "darwin-launchd" || targetId === "linux-systemd") continue;
      hosts.push(resolveHost(targetId, opts.hostOverrides));
    }
  } else {
    hosts.push(opts.host);
  }

  for (const targetHost of hosts) {
    let plan: ArtifactSymlinkPlan;
    try {
      plan = planArtifactSymlinks({
        type: opts.type,
        manifest: opts.manifest,
        arc: opts.arc,
        host: targetHost,
        installDir: opts.installDir,
      });
    } catch {
      // A throw means the artifact CANNOT have been validly dropped (e.g. an
      // unsafe bot-pack id) -- so a recorded "active" cannot reflect a real
      // drop. Treat as not-present so the caller re-runs install, which
      // surfaces the same error loudly instead of silently skipping.
      return false;
    }

    for (const link of plan.symlinkTargets) {
      if (declaredFileTargets.has(link.target)) {
        // provides.files: plain file or symlink -- presence is what matters.
        if (!existsSync(link.target)) return false;
      } else {
        // Primary per-type drop: must be a valid (non-dangling) symlink.
        if (!(await isValidSymlink(link.target))) return false;
      }
    }
  }

  return true;
}

export async function createArtifactSymlinks(opts: {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Target host adapter. Defaults to Claude-Code in the caller. */
  host: HostAdapter;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}): Promise<{
  filesCreated: { source: string; target: string }[];
  filesMissingSource: { source: string; target: string }[];
  record: ArtifactSymlinkRecord;
}> {
  const { type, manifest, arc, host, installDir, quiet } = opts;
  const record: ArtifactSymlinkRecord = { symlinks: [], shims: { dir: arc.shimDir, names: [] } };

  // Path computation is delegated to planArtifactSymlinks (arc#248) -- the SAME
  // plan the drop-presence verifier consumes -- so this step only APPLIES the
  // plan to the filesystem (plus the `rules` template-generation side effect
  // that has no symlink target).
  const plan = planArtifactSymlinks(opts);
  if (plan.filesMissingSource.length) {
    return { filesCreated: [], filesMissingSource: plan.filesMissingSource, record };
  }

  // `rules` is the one type whose apply step has a side effect with no symlink
  // target (template generation into the consumer repo).
  if (type === "rules") {
    const templates = manifest.provides?.templates ?? [];
    if (templates.length) {
      const consumerDir = opts.consumerDir ?? process.cwd();
      const results = await generateRules(installDir, templates, consumerDir);
      if (!quiet) {
        for (const r of results) {
          if (r.success && r.target) {
            console.log(`  Generated ${r.target}`);
          } else if (!r.success) {
            console.log(`  \u26A0 ${r.target}: ${r.error}`);
          }
        }
      }
    }
  }

  // Apply the plan. provides.files targets may land outside the dirs
  // ensureDirectories pre-created; createSymlink mkdir's the parent regardless,
  // but we keep an explicit mkdir for the provides.files subset to preserve
  // prior behavior and to populate `filesCreated`.
  const declaredFileTargets = new Set(
    (manifest.provides?.files ?? []).map((f) => f.target.replace(/^~/, homedir())),
  );
  const filesCreated: { source: string; target: string }[] = [];
  for (const link of plan.symlinkTargets) {
    const isProvidesFile = declaredFileTargets.has(link.target);
    if (isProvidesFile) {
      await mkdir(dirname(link.target), { recursive: true });
    }
    await createSymlink(link.source, link.target);
    record.symlinks.push(link.target);
    if (isProvidesFile) {
      filesCreated.push({ source: link.source, target: link.target });
    }
  }

  // Shims: createCliShim derives the SAME names from the manifest the plan did,
  // so create them once when the plan expects a shim set (mirrors the prior
  // per-type shim creation).
  if (plan.shimNames.length) {
    const created = await createCliShim(arc.shimDir, host.paths.binDir, manifest);
    record.shims.names.push(...created);
  }

  return { filesCreated, filesMissingSource: [], record };
}

/**
 * Roll back every symlink and shim recorded by createArtifactSymlinks.
 *
 * Called by install on:
 *   - Hook-validation gate failure (issue #89): symlinks placed but hooks
 *     not yet registered. Caller only needs this helper.
 *   - Postinstall-script failure (issue #97): symlinks AND hooks both placed
 *     before the script ran, so the caller pairs this with removeHooks
 *     before returning. recordInstall hasn't happened yet at that point,
 *     so no DB row to clean up.
 *
 * Best-effort across all entries: an ENOENT on one path doesn't abort
 * cleanup of the others. Non-ENOENT errors (e.g. permission denied) are
 * surfaced via console.warn so the user sees orphans they need to inspect
 * manually rather than failing silently.
 */
export async function rollbackArtifactSymlinks(record: ArtifactSymlinkRecord): Promise<void> {
  for (const link of record.symlinks) {
    try {
      await removeSymlink(link);
    } catch (err) {
      if (!isErrno(err) || err.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove symlink ${link}: ${errorMessage(err)}`);
      }
    }
  }
  for (const name of record.shims.names) {
    try {
      await removeCliShim(record.shims.dir, name);
    } catch (err) {
      if (!isErrno(err) || err.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove shim ${name}: ${errorMessage(err)}`);
      }
    }
  }
}

export interface NodeDependencyInstallResult {
  /** false when there was no package.json — nothing to install, not an error. */
  ran: boolean;
  success: boolean;
  /** Best-effort top-level node_modules entry count, for the summary line. */
  packageCount?: number;
  usedFrozenLockfile: boolean;
  /** Tail of stderr when `success` is false. */
  error?: string;
}

/**
 * Run `bun install` if `package.json` exists in the given directory — so a
 * package's (or plugin bundle's, arc#284) declared npm dependencies resolve
 * into `node_modules` before symlinks/postinstall run (this is what makes
 * cortex's dynamic `import()` of a bundle entry resolve its deps).
 *
 * `--production` skips devDependencies (not needed at runtime). A lockfile
 * (`bun.lock` / legacy `bun.lockb`) present in the directory gets
 * `--frozen-lockfile` — reproducible, matches what the author tested; its
 * absence drops the flag (nothing committed to freeze against, e.g. a repo
 * cloned without a checked-in lockfile).
 *
 * Idempotent by construction: `bun install` re-run against an
 * already-satisfied `node_modules` is a fast no-op (arc#284 acceptance
 * criterion — re-install must be idempotent).
 *
 * Best-effort: a failure here does NOT throw or abort the caller's install —
 * many packages ship a `package.json` for dev tooling that's never imported
 * at runtime, so a resolution failure isn't necessarily fatal to the
 * package overall (same WARN-not-hard-fail posture as the confidentiality
 * gate during its burn-in window). Callers MUST surface a failed result via
 * `reportNodeDependencyResult` — silently discarding it would hide a bundle
 * whose adapter/renderer entry can never resolve its deps.
 */
export function installNodeDependencies(dir: string): NodeDependencyInstallResult {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { ran: false, success: true, usedFrozenLockfile: false };
  }

  const hasLockfile =
    existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
  const args = ["bun", "install", "--production", ...(hasLockfile ? ["--frozen-lockfile"] : [])];

  const result = Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) {
    const stderrTail = result.stderr
      .toString()
      .trim()
      .split("\n")
      .slice(-5)
      .join("\n");
    return {
      ran: true,
      success: false,
      usedFrozenLockfile: hasLockfile,
      error: stderrTail || `bun install exited ${result.exitCode}`,
    };
  }

  return {
    ran: true,
    success: true,
    usedFrozenLockfile: hasLockfile,
    packageCount: countTopLevelNodeModules(dir),
  };
}

/** Best-effort count of top-level node_modules entries (not the full
 * resolved dependency-tree size, but enough for a one-line summary). */
function countTopLevelNodeModules(dir: string): number | undefined {
  try {
    const nodeModulesDir = join(dir, "node_modules");
    if (!existsSync(nodeModulesDir)) return undefined;
    return readdirSync(nodeModulesDir).filter((name) => !name.startsWith(".")).length;
  } catch {
    return undefined;
  }
}

/**
 * Surface a `bun install` result on the install log. Mirrors
 * `reportProvisioningResult` (identity-provision.ts): a FAILURE is written
 * to stderr unconditionally (even under `--yes`/quiet) so a bundle never
 * silently ships with an unresolved `node_modules`; a success respects
 * `quiet`. No-op when nothing ran (no package.json).
 */
export function reportNodeDependencyResult(
  result: NodeDependencyInstallResult,
  packageLabel: string,
  quiet = false,
): void {
  if (!result.ran) return;
  if (!result.success) {
    process.stderr.write(
      `arc: bun install failed for ${packageLabel} (node_modules may be incomplete):\n${result.error}\n`,
    );
    return;
  }
  if (!quiet) {
    const count = result.packageCount != null ? `${result.packageCount} package(s)` : "dependencies";
    const mode = result.usedFrozenLockfile ? "--frozen-lockfile" : "no lockfile";
    console.log(`  ✓ bun install: ${count} for ${packageLabel} (${mode})`);
  }
}

/**
 * Parse a "library:artifact" colon-separated reference.
 *
 * Returns null if the ref looks like a URL (contains "/") rather than a library ref.
 * If there's no colon, returns { libraryName: ref } indicating the whole library.
 *
 * Examples:
 *   "mylib:tool-a"  -> { libraryName: "mylib", artifactName: "tool-a" }
 *   "mylib"         -> { libraryName: "mylib" }
 *   "https://..."   -> null (URL, not a library ref)
 *   "org/repo"      -> null (URL-like path)
 */
export function parseLibraryRef(ref: string): { libraryName: string; artifactName?: string } | null {
  // URLs contain "/" — not a library ref
  if (ref.includes("/")) {
    return null;
  }

  const colonIndex = ref.indexOf(":");
  if (colonIndex === -1) {
    // No colon: whole library
    return { libraryName: ref };
  }

  const libraryName = ref.slice(0, colonIndex);
  const artifactName = ref.slice(colonIndex + 1);

  if (!libraryName) {
    return null;
  }

  return { libraryName, artifactName: artifactName || undefined };
}

/** A library artifact paired with its manifest, as read by readLibraryArtifacts. */
export interface ArtifactEntry {
  entry: LibraryArtifactEntry;
  manifest: ArcManifest;
}

/**
 * Topologically sort a library's artifacts by `depends_on.packages`.
 *
 * F-6c (arc#227): library installs must land each artifact AFTER the artifacts
 * it depends on, so that e.g. `pilot` (depends_on agent-state) installs only
 * once `agent-state` is in place. Only intra-library dependencies constrain
 * ordering — a `depends_on.packages` entry that names a package NOT contained
 * in this library (an external dep such as a tool, or another repo's package)
 * is an install-time gate handled elsewhere (`install.ts` dep check), not an
 * ordering edge, so it is ignored here.
 *
 * Algorithm: Kahn's algorithm over the dependency DAG. Independent peers keep
 * their declaration order (stable), which keeps console output and the journal
 * deterministic. A cycle (direct, self, or transitive) leaves nodes unemitted
 * and throws with the offending names so the operator can fix the manifests.
 *
 * @throws Error if a dependency cycle is detected.
 */
export function toposortArtifacts(artifacts: ArtifactEntry[]): ArtifactEntry[] {
  // Index by artifact name so we can tell intra-library deps from external ones.
  const byName = new Map<string, ArtifactEntry>();
  for (const a of artifacts) {
    byName.set(a.manifest.name, a);
  }

  // Build the dependency edges (dependency -> dependent) and in-degrees,
  // counting only deps that resolve to another artifact in THIS library.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of artifacts) {
    inDegree.set(a.manifest.name, inDegree.get(a.manifest.name) ?? 0);
  }
  for (const a of artifacts) {
    const deps = a.manifest.depends_on?.packages ?? [];
    for (const dep of deps) {
      if (!byName.has(dep.name)) continue; // external dep — not an ordering edge
      const list = dependents.get(dep.name) ?? [];
      list.push(a.manifest.name);
      dependents.set(dep.name, list);
      inDegree.set(a.manifest.name, (inDegree.get(a.manifest.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm. Seed the queue in declaration order to keep peers stable.
  const queue: string[] = [];
  for (const a of artifacts) {
    if ((inDegree.get(a.manifest.name) ?? 0) === 0) {
      queue.push(a.manifest.name);
    }
  }

  const ordered: ArtifactEntry[] = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const name = queue[cursor++];
    const node = byName.get(name);
    if (node) ordered.push(node);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== artifacts.length) {
    const emitted = new Set(ordered.map((o) => o.manifest.name));
    const unresolved = artifacts
      .map((a) => a.manifest.name)
      .filter((n) => !emitted.has(n));
    throw new Error(
      `Dependency cycle detected among library artifacts: ${unresolved.join(", ")}`,
    );
  }

  return ordered;
}

/**
 * Read the RAW `id:` string from a cortex agent identity fragment. Returns
 * `undefined` when the file is unreadable, not a YAML map, or `id` is absent
 * or not a string — those cases fall back to the manifest name (the caller
 * validates safety either way; cortex's loader validates the fragment after
 * the drop). NO safety filtering here: a present-but-unsafe id must surface
 * as an error upstream, never silently degrade to the fallback.
 */
function readRawAgentFragmentId(fragmentPath: string): string | undefined {
  try {
    const raw = YAML.parse(readFileSync(fragmentPath, "utf-8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const id = (raw as Record<string, unknown>).id;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
  } catch (err) {
    console.warn(
      `arc: could not read agent fragment id from ${fragmentPath}: ${errorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * An agent id is used as a FILENAME STEM under agents.d/ and personas/ — it
 * must not be able to escape those directories (sage arc#238 round 1
 * blocker: an id containing `/` or `..` would symlink outside agents.d).
 * Accepts cortex-conventional ids only: case-insensitive alphanumerics
 * plus `.`, `_`, `-`, starting alphanumeric, and no `..` sequence anywhere.
 * Returns `undefined` for anything else.
 */
export function sanitizeAgentId(id: string): string | undefined {
  if (id.length === 0 || id.length > 128) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return undefined;
  if (id.includes("..")) return undefined;
  return id;
}
