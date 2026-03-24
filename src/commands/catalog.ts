import { join } from "path";
import { existsSync } from "fs";
import { mkdir, cp, rm } from "fs/promises";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { PaiPaths, CatalogEntry, ArtifactType } from "../types.js";
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
import { createSymlink, createCliShim, extractCliInfo } from "../lib/symlinks.js";

// ── Result types ──────────────────────────────────────────────

export interface CatalogListResult {
  success: boolean;
  items?: CatalogListItem[];
  error?: string;
}

export interface CatalogSearchResult {
  success: boolean;
  results?: Array<{ entry: CatalogEntry; artifactType: ArtifactType }>;
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
  installed?: Array<{ name: string; artifactType: ArtifactType }>;
  error?: string;
}

export interface CatalogPushResult {
  success: boolean;
  name?: string;
  error?: string;
}

export interface CatalogSyncResult {
  success: boolean;
  synced?: Array<{ name: string; status: "ok" | "failed"; error?: string }>;
  error?: string;
}

// ── Commands ──────────────────────────────────────────────────

export async function catalogList(
  paths: PaiPaths,
  db: Database
): Promise<CatalogListResult> {
  const config = await loadCatalog(paths.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const items = listCatalog(config, db);
  return { success: true, items };
}

export async function catalogSearch(
  paths: PaiPaths,
  keyword: string
): Promise<CatalogSearchResult> {
  const config = await loadCatalog(paths.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const results = searchCatalog(config, keyword);
  return { success: true, results };
}

export async function catalogAdd(
  paths: PaiPaths,
  entry: CatalogEntry,
  artifactType: ArtifactType
): Promise<CatalogAddResult> {
  const config = await loadCatalog(paths.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  try {
    addEntry(config, entry, artifactType);
    await saveCatalog(paths.catalogPath, config);
    return { success: true, name: entry.name, artifactType };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function catalogRemove(
  paths: PaiPaths,
  name: string
): Promise<CatalogRemoveResult> {
  const config = await loadCatalog(paths.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const removed = removeEntry(config, name);
  if (!removed) {
    return { success: false, error: `Entry "${name}" not found in catalog` };
  }

  await saveCatalog(paths.catalogPath, config);
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
  paths: PaiPaths,
  db: Database,
  name: string
): Promise<CatalogUseResult> {
  const config = await loadCatalog(paths.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  // Resolve dependency tree
  let ordered: Array<{ entry: CatalogEntry; artifactType: ArtifactType }>;
  try {
    ordered = resolveDependencies(config, name);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const installed: Array<{ name: string; artifactType: ArtifactType }> = [];

  for (const { entry, artifactType } of ordered) {
    const result = await installEntry(paths, db, entry, artifactType, config);
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
  paths: PaiPaths,
  db: Database
): Promise<CatalogSyncResult> {
  const config = await loadCatalog(paths.catalogPath);
  if (!config) {
    return { success: false, error: "No catalog.yaml found" };
  }

  const items = listCatalog(config, db);
  const installedItems = items.filter((i) => i.installed);

  if (installedItems.length === 0) {
    return { success: true, synced: [] };
  }

  const synced: Array<{ name: string; status: "ok" | "failed"; error?: string }> = [];

  for (const item of installedItems) {
    const result = await installEntry(
      paths,
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
  paths: PaiPaths,
  name: string
): Promise<CatalogPushResult> {
  const config = await loadCatalog(paths.catalogPath);
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
      ? join(paths.skillsDir, entry.name)
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
  const tmpDir = join(paths.reposDir, `_push_${name}_${Date.now()}`);
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

    // Stage, commit, push
    const pathInRepo = resolved.parentPath === "." ? "." : resolved.parentPath;
    Bun.spawnSync(["git", "add", pathInRepo], { cwd: tmpDir, stdout: "pipe", stderr: "pipe" });

    const commitResult = Bun.spawnSync(
      ["git", "commit", "-m", `pai-pkg: update ${name}`],
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
 */
export async function catalogPushCatalog(
  paths: PaiPaths
): Promise<{ success: boolean; error?: string }> {
  const catalogDir = join(paths.catalogPath, "..");

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
  paths: PaiPaths,
  db: Database,
  entry: CatalogEntry,
  artifactType: ArtifactType,
  config: { defaults: { skills_dir: string; agents_dir: string; prompts_dir: string } }
): Promise<EntryInstallResult> {
  if (artifactType === "skill") {
    return installSkillEntry(paths, db, entry);
  }

  if (artifactType === "agent") {
    return installAgentEntry(paths, entry, config.defaults.agents_dir);
  }

  if (artifactType === "prompt") {
    return installPromptEntry(paths, entry, config.defaults.prompts_dir);
  }

  return { success: false, error: `Unknown artifact type: ${artifactType}` };
}

async function installSkillEntry(
  paths: PaiPaths,
  db: Database,
  entry: CatalogEntry
): Promise<EntryInstallResult> {
  const resolved = resolveSource(entry.source);
  const isCli = entry.has_cli || entry.bundle;
  const installDir = join(isCli ? paths.reposDir : paths.skillsDir, entry.name);
  const skillLinkDir = join(paths.skillsDir, entry.name);
  const isRefresh = getSkill(db, entry.name) !== null;

  if (resolved.type === "local") {
    // For CLI skills: find the repo root (walk up from skill dir to find pai-manifest.yaml)
    // For simple skills: just copy the parent dir of SKILL.md
    let sourceDir = resolved.parentPath;
    if (isCli) {
      sourceDir = findRepoRoot(resolved.parentPath);
    }

    if (existsSync(installDir)) {
      await rm(installDir, { recursive: true, force: true });
    }
    await mkdir(isCli ? paths.reposDir : paths.skillsDir, { recursive: true });
    await cp(sourceDir, installDir, { recursive: true });
  } else {
    // GitHub source: clone to temp, extract
    const tmpDir = join(paths.reposDir, `_tmp_${entry.name}_${Date.now()}`);
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
      await mkdir(isCli ? paths.reposDir : paths.skillsDir, { recursive: true });
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
      await createCliShim(paths.shimDir, paths.binDir, manifest);
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
      installed_at: now,
      updated_at: now,
    },
    manifest ?? emptyManifest
  );

  return { success: true };
}

/**
 * Walk up from a directory to find the repo root (where pai-manifest.yaml or package.json lives).
 * Falls back to the given dir if nothing found.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (
      existsSync(join(dir, "pai-manifest.yaml")) ||
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

async function installAgentEntry(
  paths: PaiPaths,
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
  const tmpDir = join(paths.reposDir, `_tmp_${entry.name}_${Date.now()}`);
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

async function installPromptEntry(
  paths: PaiPaths,
  entry: CatalogEntry,
  promptsDir: string
): Promise<EntryInstallResult> {
  // Same logic as agent — single file copy
  return installAgentEntry(paths, entry, promptsDir);
}
