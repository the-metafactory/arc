import { join } from "path";
import { existsSync } from "fs";
import { mkdir, cp, rm } from "fs/promises";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { ArcPaths, HostAdapter, CatalogEntry, ArtifactType } from "../types.js";
import { MANIFEST_FILENAMES } from "../lib/manifest.js";
import {
  loadCatalog,
  saveCatalog,
  findEntry,
  searchCatalog,
  listCatalog,
  addEntry,
  removeEntry,
  resolveDependencies,
  type CatalogListItem,
} from "../lib/catalog.js";
import { resolveSource } from "../lib/source-resolver.js";
import { readManifest } from "../lib/manifest.js";
import { recordInstall, getSkill } from "../lib/db.js";
import { createSymlink, createCliShim } from "../lib/symlinks.js";

// ── Result types ──────────────────────────────────────────────

export interface CatalogListResult {
  success: boolean;
  items?: CatalogListItem[];
  error?: string;
}

export interface CatalogSearchResult {
  success: boolean;
  results?: { entry: CatalogEntry; artifactType: ArtifactType }[];
  error?: string;
}

export interface CatalogAddResult {
  success: boolean;
  name?: string;
  artifactType?: ArtifactType;
  error?: string;
}

export interface CatalogRemoveResult {
  success: boolean;
  name?: string;
  error?: string;
}

export interface CatalogUseResult {
  success: boolean;
  installed?: { name: string; artifactType: ArtifactType }[];
  error?: string;
}

export interface CatalogPushResult {
  success: boolean;
  name?: string;
  error?: string;
}

export interface CatalogSyncResult {
  success: boolean;
  synced?: { name: string; status: "ok" | "failed"; error?: string }[];
  error?: string;
}

// ── Commands ──────────────────────────────────────────────────

/**
 * @param host Unused today; threaded for #117 signature consistency. catalogList only
 *   reads the catalog file (arc state) and per-skill install status from db.
 */
export async function catalogList(
  arc: ArcPaths,
  host: HostAdapter,
  db: Database
): Promise<CatalogListResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const items = listCatalog(config, db);
  return { success: true, items };
}

/**
 * @param host Unused today; threaded for #117 signature consistency. catalogSearch
 *   reads the catalog file (arc state) only.
 */
export async function catalogSearch(
  arc: ArcPaths,
  host: HostAdapter,
  keyword: string
): Promise<CatalogSearchResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const results = searchCatalog(config, keyword);
  return { success: true, results };
}

/**
 * @param host Unused today; threaded for #117 signature consistency. catalogAdd
 *   only mutates the catalog file (arc state).
 */
export async function catalogAdd(
  arc: ArcPaths,
  host: HostAdapter,
  entry: CatalogEntry,
  artifactType: ArtifactType
): Promise<CatalogAddResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  try {
    addEntry(config, entry, artifactType);
    await saveCatalog(arc.catalogPath, config);
    return { success: true, name: entry.name, artifactType };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * @param host Unused today; threaded for #117 signature consistency. catalogRemove
 *   only mutates the catalog file (arc state).
 */
export async function catalogRemove(
  arc: ArcPaths,
  host: HostAdapter,
  name: string
): Promise<CatalogRemoveResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const removed = removeEntry(config, name);
  if (!removed) {
    return { success: false, error: `Entry "${name}" not found in catalog` };
  }

  await saveCatalog(arc.catalogPath, config);
  return { success: true, name };
}

/**
 * Install a catalog entry (and its dependencies).
 *
 * For skills: resolves source, clones/copies, delegates to install pipeline.
 * For agents: copies .md file to agents dir.
 * For prompts: copies .md file to prompts dir.
 */
export async function catalogUse(
  arc: ArcPaths,
  host: HostAdapter,
  db: Database,
  name: string
): Promise<CatalogUseResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  // Resolve dependency tree
  let ordered: { entry: CatalogEntry; artifactType: ArtifactType }[];
  try {
    ordered = resolveDependencies(config, name);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const installed: { name: string; artifactType: ArtifactType }[] = [];

  for (const { entry, artifactType } of ordered) {
    const result = await installEntry(arc, host, db, entry, artifactType, config);
    if (!result.success) {
      return {
        success: false,
        installed,
        error: `Failed to install ${entry.name}: ${result.error}`,
      };
    }
    installed.push({ name: entry.name, artifactType });
  }

  return { success: true, installed };
}

/**
 * Re-pull all installed catalog entries from source.
 */
export async function catalogSync(
  arc: ArcPaths,
  host: HostAdapter,
  db: Database
): Promise<CatalogSyncResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const items = listCatalog(config, db);
  const installedItems = items.filter((i) => i.installed);

  if (installedItems.length === 0) {
    return { success: true, synced: [] };
  }

  const synced: { name: string; status: "ok" | "failed"; error?: string }[] = [];

  for (const item of installedItems) {
    const result = await installEntry(
      arc,
      host,
      db,
      item.entry,
      item.artifactType,
      config
    );
    synced.push({
      name: item.entry.name,
      status: result.success ? "ok" : "failed",
      error: result.error,
    });
  }

  return { success: true, synced };
}

/**
 * Push local changes to a catalog entry back to its source.
 * Local sources: copy back. GitHub sources: clone, overlay, commit, push.
 */
export async function catalogPush(
  arc: ArcPaths,
  host: HostAdapter,
  name: string
): Promise<CatalogPushResult> {
  const config = await loadCatalog(arc.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const found = findEntry(config, name);
  if (!found) {
    return { success: false, error: `"${name}" not found in catalog` };
  }

  const { entry, artifactType } = found;
  const resolved = resolveSource(entry.source);

  // Determine local installed path
  const localPath =
    artifactType === "skill"
      ? join(host.paths.skillsDir, entry.name)
      : artifactType === "agent"
        ? join(
            config.defaults.agents_dir.replace(/^~/, homedir()),
            resolved.filename
          )
        : join(
            config.defaults.prompts_dir.replace(/^~/, homedir()),
            resolved.filename
          );

  if (!existsSync(localPath)) {
    return { success: false, error: `${name} is not installed locally` };
  }

  if (resolved.type === "local") {
    // Local source: copy back
    if (artifactType === "skill") {
      await rm(resolved.parentPath, { recursive: true, force: true });
      await cp(localPath, resolved.parentPath, { recursive: true });
    } else {
      const targetPath = join(resolved.parentPath, resolved.filename);
      await cp(localPath, targetPath);
    }
    return { success: true, name };
  }

  // GitHub source: clone, overlay, commit, push
  const tmpDir = join(arc.reposDir, `_push_${name}_${Date.now()}`);
  try {
    let cloneResult = Bun.spawnSync(
      ["git", "clone", "--depth", "1", "--branch", resolved.branch!, resolved.cloneUrl, tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );

    if (cloneResult.exitCode !== 0) {
      const sshUrl = `git@github.com:${resolved.org}/${resolved.repo}.git`;
      cloneResult = Bun.spawnSync(
        ["git", "clone", "--depth", "1", "--branch", resolved.branch!, sshUrl, tmpDir],
        { stdout: "pipe", stderr: "pipe" }
      );
    }

    if (cloneResult.exitCode !== 0) {
      return { success: false, error: `git clone failed: ${cloneResult.stderr.toString().trim()}` };
    }

    // Overlay local changes into the clone
    if (artifactType === "skill") {
      const targetDir =
        resolved.parentPath === "."
          ? tmpDir
          : join(tmpDir, resolved.parentPath);
      await rm(targetDir, { recursive: true, force: true });
      await cp(localPath, targetDir, { recursive: true });
    } else {
      const targetFile =
        resolved.parentPath === "."
          ? join(tmpDir, resolved.filename)
          : join(tmpDir, resolved.parentPath, resolved.filename);
      await cp(localPath, targetFile);
    }

    // Verify the remote URL matches the expected source before pushing
    const remoteResult = Bun.spawnSync(
      ["git", "remote", "get-url", "origin"],
      { cwd: tmpDir, stdout: "pipe", stderr: "pipe" }
    );
    const actualRemote = remoteResult.stdout.toString().trim();
    const expectedRemotes = [
      resolved.cloneUrl,
      `git@github.com:${resolved.org}/${resolved.repo}.git`,
    ];
    if (!expectedRemotes.some((u) => actualRemote === u)) {
      return {
        success: false,
        error: `Push target mismatch: remote is "${actualRemote}" but expected "${resolved.cloneUrl}". Refusing to push.`,
      };
    }

    // Stage, commit, push
    const pathInRepo = resolved.parentPath === "." ? "." : resolved.parentPath;
    const addResult = Bun.spawnSync(["git", "add", pathInRepo], { cwd: tmpDir, stdout: "pipe", stderr: "pipe" });
    if (addResult.exitCode !== 0) {
      return { success: false, error: `git add failed: ${addResult.stderr.toString().trim()}` };
    }

    const commitResult = Bun.spawnSync(
      ["git", "commit", "-m", `arc: update ${name}`],
      { cwd: tmpDir, stdout: "pipe", stderr: "pipe" }
    );
    if (commitResult.exitCode !== 0) {
      const msg = commitResult.stderr.toString().trim();
      if (msg.includes("nothing to commit")) {
        return { success: true, name }; // no changes to push
      }
      return { success: false, error: `git commit failed: ${msg}` };
    }

    const pushResult = Bun.spawnSync(
      ["git", "push"],
      { cwd: tmpDir, stdout: "pipe", stderr: "pipe" }
    );
    if (pushResult.exitCode !== 0) {
      return { success: false, error: `git push failed: ${pushResult.stderr.toString().trim()}` };
    }

    return { success: true, name };
  } finally {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Commit and push catalog.yaml to git remote.
 *
 * @param host Unused today; threaded for #117 signature consistency. catalogPushCatalog
 *   only invokes git against the catalog file (arc state).
 */
export async function catalogPushCatalog(
  arc: ArcPaths,
  _host: HostAdapter
): Promise<{ success: boolean; error?: string }> {
  const catalogDir = join(arc.catalogPath, "..");

  const statusResult = Bun.spawnSync(
    ["git", "status", "--porcelain", "catalog.yaml"],
    { cwd: catalogDir, stdout: "pipe", stderr: "pipe" }
  );

  const changes = statusResult.stdout.toString().trim();
  if (!changes) {
    return { success: true }; // nothing to push
  }

  const addResult = Bun.spawnSync(
    ["git", "add", "catalog.yaml"],
    { cwd: catalogDir, stdout: "pipe", stderr: "pipe" }
  );
  if (addResult.exitCode !== 0) {
    return { success: false, error: "git add failed" };
  }

  const commitResult = Bun.spawnSync(
    ["git", "commit", "-m", "chore: update catalog.yaml"],
    { cwd: catalogDir, stdout: "pipe", stderr: "pipe" }
  );
  if (commitResult.exitCode !== 0) {
    return {
      success: false,
      error: `git commit failed: ${commitResult.stderr.toString().trim()}`,
    };
  }

  const pushResult = Bun.spawnSync(
    ["git", "push"],
    { cwd: catalogDir, stdout: "pipe", stderr: "pipe" }
  );
  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      error: `git push failed: ${pushResult.stderr.toString().trim()}`,
    };
  }

  return { success: true };
}

// ── Formatters ────────────────────────────────────────────────

export function formatCatalogList(result: CatalogListResult): string {
  if (!result.success) return `Error: ${result.error}`;
  if (!result.items?.length) return "Catalog is empty.";

  const lines: string[] = [`Catalog (${result.items.length} entries):`, ""];

  for (const item of result.items) {
    const badge = item.installed
      ? item.status === "active"
        ? "✅"
        : "⏸️"
      : "  ";
    const typeTag = `[${item.artifactType}]`;
    const entryType = item.entry.type !== "builtin" ? ` (${item.entry.type})` : "";
    lines.push(
      `  ${badge} ${item.entry.name} ${typeTag}${entryType} — ${item.entry.description}`
    );
  }

  return lines.join("\n");
}

export function formatCatalogSearch(result: CatalogSearchResult): string {
  if (!result.success) return `Error: ${result.error}`;
  if (!result.results?.length) return "No matches found.";

  const lines: string[] = [`Found ${result.results.length} match(es):`, ""];

  for (const { entry, artifactType } of result.results) {
    lines.push(`  ${entry.name} [${artifactType}] — ${entry.description}`);
    lines.push(`    source: ${entry.source}`);
  }

  return lines.join("\n");
}

// ── Internal helpers ──────────────────────────────────────────

interface EntryInstallResult {
  success: boolean;
  error?: string;
}

async function installEntry(
  arc: ArcPaths,
  host: HostAdapter,
  db: Database,
  entry: CatalogEntry,
  artifactType: ArtifactType,
  config: { defaults: { skills_dir: string; agents_dir: string; prompts_dir: string } }
): Promise<EntryInstallResult> {
  if (artifactType === "skill") {
    return installSkillEntry(arc, host, db, entry);
  }

  if (artifactType === "agent") {
    return installAgentEntry(arc, host, entry, config.defaults.agents_dir);
  }

  if (artifactType === "prompt") {
    return installPromptEntry(arc, host, entry, config.defaults.prompts_dir);
  }

  return { success: false, error: `Unknown artifact type: ${artifactType}` };
}

async function installSkillEntry(
  arc: ArcPaths,
  host: HostAdapter,
  db: Database,
  entry: CatalogEntry
): Promise<EntryInstallResult> {
  const resolved = resolveSource(entry.source);
  const isCli = entry.has_cli || entry.bundle;
  const baseDir = isCli ? arc.reposDir : host.paths.skillsDir;
  const installDir = join(baseDir, entry.name);
  const skillLinkDir = join(host.paths.skillsDir, entry.name);

  // Path traversal guard — ensure installDir stays inside the target directory
  if (!join(installDir).startsWith(join(baseDir) + "/")) {
    return { success: false, error: `Refusing to install: name "${entry.name}" would escape install directory` };
  }

  const isRefresh = getSkill(db, entry.name) !== null;

  if (resolved.type === "local") {
    // For CLI skills: find the repo root (walk up from skill dir to find arc-manifest.yaml)
    // For simple skills: just copy the parent dir of SKILL.md
    let sourceDir = resolved.parentPath;
    if (isCli) {
      sourceDir = findRepoRoot(resolved.parentPath);
    }

    if (existsSync(installDir)) {
      await rm(installDir, { recursive: true, force: true });
    }
    await mkdir(isCli ? arc.reposDir : host.paths.skillsDir, { recursive: true });
    await cp(sourceDir, installDir, { recursive: true });
  } else {
    // GitHub source: clone to temp, extract
    const tmpDir = join(arc.reposDir, `_tmp_${entry.name}_${Date.now()}`);
    try {
      let cloneResult = Bun.spawnSync(
        ["git", "clone", "--depth", "1", "--branch", resolved.branch!, resolved.cloneUrl, tmpDir],
        { stdout: "pipe", stderr: "pipe" }
      );

      if (cloneResult.exitCode !== 0) {
        const sshUrl = `git@github.com:${resolved.org}/${resolved.repo}.git`;
        cloneResult = Bun.spawnSync(
          ["git", "clone", "--depth", "1", "--branch", resolved.branch!, sshUrl, tmpDir],
          { stdout: "pipe", stderr: "pipe" }
        );
      }

      if (cloneResult.exitCode !== 0) {
        return {
          success: false,
          error: `git clone failed: ${cloneResult.stderr.toString().trim()}`,
        };
      }

      // For CLI skills: install the whole repo. For simple skills: just the skill subdir.
      const sourceDir = isCli
        ? tmpDir
        : resolved.parentPath === "."
          ? tmpDir
          : join(tmpDir, resolved.parentPath);

      if (existsSync(installDir)) {
        await rm(installDir, { recursive: true, force: true });
      }
      await mkdir(isCli ? arc.reposDir : host.paths.skillsDir, { recursive: true });
      await cp(sourceDir, installDir, { recursive: true });
    } finally {
      if (existsSync(tmpDir)) {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  }

  // For CLI skills: create symlink from skills dir to repo's skill/ subdir
  if (isCli) {
    const skillSubDir = join(installDir, "skill");
    const symlinkTarget = existsSync(skillSubDir) ? skillSubDir : installDir;
    if (existsSync(skillLinkDir)) {
      await rm(skillLinkDir, { recursive: true, force: true });
    }
    await createSymlink(symlinkTarget, skillLinkDir);
  }

  // Read manifest if present (security pipeline)
  // For CLI skills, manifest is at the repo root (installDir)
  // For simple skills, manifest might be in the skill dir
  const manifestDir = isCli ? installDir : skillLinkDir;
  const manifest = await readManifest(manifestDir);

  // CLI tooling: bun install + shims
  if (isCli) {
    const packageJsonPath = join(installDir, "package.json");
    if (existsSync(packageJsonPath)) {
      Bun.spawnSync(["bun", "install"], {
        cwd: installDir,
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    if (manifest) {
      await createCliShim(arc.shimDir, host.paths.binDir, manifest);
    }
  }

  // Record in DB (update if refresh, insert if new)
  if (isRefresh) {
    db.prepare("DELETE FROM skills WHERE name = ?").run(entry.name);
  }
  const now = new Date().toISOString();
  const emptyManifest = {
    name: entry.name,
    version: "0.0.0",
    type: "skill" as const,
    author: { name: "unknown", github: "unknown" },
    capabilities: {},
  };
  recordInstall(
    db,
    {
      name: entry.name,
      version: manifest?.version ?? "0.0.0",
      repo_url: entry.source,
      install_path: installDir,
      skill_dir: isCli ? join(installDir, "skill") : installDir,
      status: "active",
      artifact_type: (manifest?.type as ArtifactType) ?? "skill",
      tier: "custom",
      customization_path: null,
      install_source: entry.source,
      library_name: null,
      installed_at: now,
      updated_at: now,
    },
    manifest ?? emptyManifest
  );

  return { success: true };
}

/**
 * Walk up from a directory to find the repo root (where arc-manifest.yaml or package.json lives).
 * Falls back to the given dir if nothing found.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (
      MANIFEST_FILENAMES.some((f) => existsSync(join(dir, f))) ||
      existsSync(join(dir, "package.json")) ||
      existsSync(join(dir, ".git"))
    ) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/**
 * @param host Unused today; threaded for #117 signature consistency. installAgentEntry
 *   writes to `agentsDir` passed by the caller (catalogUse), which already resolved
 *   it from config defaults — not from host.paths.agentsDir.
 */
async function installAgentEntry(
  arc: ArcPaths,
  host: HostAdapter,
  entry: CatalogEntry,
  agentsDir: string
): Promise<EntryInstallResult> {
  const resolved = resolveSource(entry.source);
  const expandedDir = agentsDir.replace(/^~/, homedir());
  await mkdir(expandedDir, { recursive: true });

  if (resolved.type === "local") {
    const sourcePath = join(resolved.parentPath, resolved.filename);
    const targetPath = join(expandedDir, resolved.filename);
    await cp(sourcePath, targetPath);
    return { success: true };
  }

  // GitHub: clone, extract the single file
  const tmpDir = join(arc.reposDir, `_tmp_${entry.name}_${Date.now()}`);
  try {
    let cloneResult = Bun.spawnSync(
      ["git", "clone", "--depth", "1", "--branch", resolved.branch!, resolved.cloneUrl, tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );

    if (cloneResult.exitCode !== 0) {
      const sshUrl = `git@github.com:${resolved.org}/${resolved.repo}.git`;
      cloneResult = Bun.spawnSync(
        ["git", "clone", "--depth", "1", "--branch", resolved.branch!, sshUrl, tmpDir],
        { stdout: "pipe", stderr: "pipe" }
      );
    }

    if (cloneResult.exitCode !== 0) {
      return {
        success: false,
        error: `git clone failed: ${cloneResult.stderr.toString().trim()}`,
      };
    }

    const sourcePath =
      resolved.parentPath === "."
        ? join(tmpDir, resolved.filename)
        : join(tmpDir, resolved.parentPath, resolved.filename);

    const targetPath = join(expandedDir, resolved.filename);
    await cp(sourcePath, targetPath);
    return { success: true };
  } finally {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * @param host Unused today; threaded for #117 signature consistency.
 *   Forwarded as-is to installAgentEntry, which also doesn't read it.
 */
async function installPromptEntry(
  arc: ArcPaths,
  host: HostAdapter,
  entry: CatalogEntry,
  promptsDir: string
): Promise<EntryInstallResult> {
  // Same logic as agent — single file copy
  return installAgentEntry(arc, host, entry, promptsDir);
}
