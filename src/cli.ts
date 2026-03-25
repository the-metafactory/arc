#!/usr/bin/env bun

import { Command } from "commander";
import { createPaths, ensureDirectories } from "./lib/paths.js";
import { openDatabase } from "./lib/db.js";
import { install } from "./commands/install.js";
import { list, formatList } from "./commands/list.js";
import { info, formatInfo } from "./commands/info.js";
import { audit, formatAudit } from "./commands/audit.js";
import { disable } from "./commands/disable.js";
import { enable } from "./commands/enable.js";
import { remove } from "./commands/remove.js";
import { verify, formatVerify } from "./commands/verify.js";
import { init } from "./commands/init.js";
import { upgradeCore, formatUpgrade } from "./commands/upgrade-core.js";
import { selfUpdate, formatSelfUpdate, checkSelfUpdate, formatSelfUpdateCheck } from "./commands/self-update.js";
import {
  checkUpgrades,
  upgradePackage,
  upgradeAll,
  formatCheckResults,
  formatUpgradeResults,
} from "./commands/upgrade.js";
import {
  catalogList,
  catalogSearch,
  catalogAdd,
  catalogRemove,
  catalogUse,
  catalogSync,
  catalogPush,
  catalogPushCatalog,
  formatCatalogList,
  formatCatalogSearch,
} from "./commands/catalog.js";
import type { CatalogEntry, ArtifactType, PackageTier } from "../types.js";
import { loadCatalog, saveCatalog, findEntry } from "./lib/catalog.js";
import {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  formatSourceList,
} from "./lib/sources.js";
import {
  searchAllSources,
  findInAllSources,
  updateAllSources,
  formatSourcedSearch,
} from "./lib/remote-registry.js";
import { homedir } from "os";
import { join } from "path";

const pkg = require("../package.json");

const program = new Command();

program
  .name("pai-pkg")
  .description("PAI skill package manager")
  .version(pkg.version);

program
  .command("install <name-or-url>")
  .description("Install a skill from git URL, or by name from the registry")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (nameOrUrl: string, opts: { yes?: boolean }) => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);

    const isUrl =
      nameOrUrl.includes("/") ||
      nameOrUrl.startsWith("git@") ||
      nameOrUrl.startsWith("http");

    if (isUrl) {
      // Direct git install
      const result = await install({ paths, db, repoUrl: nameOrUrl, yes: opts.yes });
      if (result.success) {
        console.log(`\n✅ Installed ${result.name} v${result.version}`);
      } else {
        console.error(`\n❌ ${result.error}`);
        process.exit(1);
      }
    } else {
      // Name-based: search all configured sources → install
      const sources = await loadSources(paths.sourcesPath);
      const found = await findInAllSources(sources, nameOrUrl, paths.cachePath);

      if (!found) {
        console.error(`❌ "${nameOrUrl}" not found in any source. Try: pai-pkg search <keyword>`);
        process.exit(1);
      }

      console.log(`Found ${nameOrUrl} [${found.artifactType}] in ${found.sourceName} [${found.sourceTier}]`);

      // Install directly from the source URL
      const result = await install({
        paths,
        db,
        repoUrl: found.entry.source,
        yes: opts.yes,
        sourceName: found.sourceName,
        sourceTier: found.sourceTier,
      });
      if (result.success) {
        console.log(`✅ Installed ${result.name} v${result.version}`);
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
    }

    db.close();
  });

program
  .command("list")
  .description("List installed skills")
  .action(() => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = list(db);
    console.log(formatList(result));
    db.close();
  });

program
  .command("info <name>")
  .description("Show details about an installed skill")
  .action(async (name: string) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await info(db, name);
    console.log(formatInfo(result));
    db.close();
  });

program
  .command("audit")
  .description("Audit total capability surface of installed skills")
  .option("--verbose", "Show all pairwise capability warnings")
  .action((opts: { verbose?: boolean }) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = audit(db);
    console.log(formatAudit(result, opts.verbose));
    db.close();
  });

program
  .command("disable <name>")
  .description("Disable an installed skill (preserves repo)")
  .action(async (name: string) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await disable(db, paths, name);

    if (result.success) {
      console.log(`⏸️  Disabled ${result.name}`);
    } else {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

program
  .command("enable <name>")
  .description("Re-enable a disabled skill")
  .action(async (name: string) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await enable(db, paths, name);

    if (result.success) {
      console.log(`✅ Enabled ${result.name}`);
    } else {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

program
  .command("remove <name>")
  .description("Completely uninstall a skill")
  .action(async (name: string) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await remove(db, paths, name);

    if (result.success) {
      console.log(`🗑️  Removed ${result.name}`);
    } else {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

program
  .command("verify <name>")
  .description("Verify integrity of an installed skill")
  .action(async (name: string) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await verify(db, paths, name);
    console.log(formatVerify(result));
    db.close();
  });

program
  .command("upgrade [name]")
  .description("Upgrade installed packages to latest version")
  .option("--check", "Only check for available upgrades, don't install")
  .action(async (name: string | undefined, opts: { check?: boolean }) => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);

    if (opts.check || !name) {
      // Check mode or upgrade-all: first show what's available
      const checks = await checkUpgrades(db, paths);

      if (opts.check) {
        // Also check if pai-pkg itself has an update
        const selfCheck = checkSelfUpdate();
        const selfMsg = formatSelfUpdateCheck(selfCheck);
        if (selfMsg) console.log(selfMsg + "\n");
        console.log(formatCheckResults(checks));
      } else {
        // No name = upgrade all
        const upgradable = checks.filter((c) => c.upgradable);
        if (!upgradable.length) {
          console.log("All packages are up to date.");
        } else {
          console.log(`Upgrading ${upgradable.length} package(s)...\n`);
          const results = await upgradeAll(db, paths);
          console.log(formatUpgradeResults(results));
        }
      }
    } else {
      // Upgrade specific package
      const result = await upgradePackage(db, paths, name);
      if (result.success) {
        if (result.oldVersion === result.newVersion) {
          console.log(`${result.name} is already at ${result.oldVersion}`);
        } else {
          console.log(`${result.name}: ${result.oldVersion} → ${result.newVersion}`);
        }
      } else {
        console.error(`${result.error}`);
        process.exit(1);
      }
    }

    db.close();
  });

program
  .command("init <name>")
  .description("Scaffold a new skill, tool, agent, or prompt repo")
  .option("-d, --dir <path>", "Target directory")
  .option("-a, --author <name>", "Author GitHub username")
  .option(
    "--type <type>",
    "Artifact type: skill, tool, agent, prompt (default: skill)"
  )
  .action(
    async (
      name: string,
      opts: { dir?: string; author?: string; type?: string }
    ) => {
      const validTypes = ["skill", "tool", "agent", "prompt"] as const;
      type ArtifactInitType = (typeof validTypes)[number];

      const artifactType: ArtifactInitType =
        opts.type && (validTypes as readonly string[]).includes(opts.type)
          ? (opts.type as ArtifactInitType)
          : "skill";

      if (opts.type && !(validTypes as readonly string[]).includes(opts.type)) {
        console.error(
          `\n❌ Unknown type "${opts.type}". Valid types: ${validTypes.join(", ")}`
        );
        process.exit(1);
      }

      // Sanitize name — prevent path traversal
      if (/[\/\\]|\.\./.test(name)) {
        console.error(`\n❌ Invalid name "${name}". Name must not contain path separators or "..".`);
        process.exit(1);
      }

      const prefix = `pai-${artifactType}`;
      const targetDir =
        opts.dir ??
        `./${prefix}-${name.replace(/^_/, "").toLowerCase()}`;
      const result = await init(targetDir, name, opts.author, artifactType);

      if (result.success) {
        console.log(`\n✅ Scaffolded ${artifactType} at ${result.path}`);
        console.log(`\nFiles created:`);
        for (const f of result.files!) {
          console.log(`  ${f}`);
        }
      } else {
        console.error(`\n❌ ${result.error}`);
        process.exit(1);
      }
    }
  );

program
  .command("upgrade-core <version>")
  .description("Upgrade PAI core to a new version (symlink management)")
  .option(
    "--versions-dir <path>",
    "PAI versions directory",
    join(homedir(), "Developer", "pai", "versions")
  )
  .option("--branch <name>", "Branch directory name", "4.0-develop")
  .option(
    "--personal-data <path>",
    "Personal data repo path",
    join(homedir(), "Developer", "pai-personal-data")
  )
  .action(
    async (
      version: string,
      opts: {
        versionsDir: string;
        branch: string;
        personalData: string;
      }
    ) => {
      const home = homedir();
      const paths = createPaths();
      const db = openDatabase(paths.dbPath);

      const result = await upgradeCore(
        db,
        {
          versionsDir: opts.versionsDir,
          branch: opts.branch,
          personalDataDir: opts.personalData,
          configRoot: paths.configRoot,
          homeDir: home,
          claudeSymlink: join(home, ".claude"),
        },
        version
      );

      console.log(formatUpgrade(result));
      db.close();

      if (!result.success) process.exit(1);
    }
  );

program
  .command("self-update")
  .description("Update pai-pkg itself (git pull + bun install)")
  .action(async () => {
    const result = await selfUpdate();
    console.log(formatSelfUpdate(result));
    if (!result.success) process.exit(1);
  });

// ── Registry search (top-level) ─────────────────────────────

program
  .command("search <keyword>")
  .description("Search all configured sources for skills, agents, and prompts")
  .action(async (keyword: string) => {
    const paths = createPaths();
    const sources = await loadSources(paths.sourcesPath);
    const results = await searchAllSources(sources, keyword, paths.cachePath);
    console.log(formatSourcedSearch(results));
  });

// ── Source commands ─────────────────────────────────────────

const source = program
  .command("source")
  .description("Manage registry sources (apt-get style)");

source
  .command("list")
  .description("List configured registry sources")
  .action(async () => {
    const paths = createPaths();
    const config = await loadSources(paths.sourcesPath);
    console.log(formatSourceList(config));
  });

source
  .command("add <name> <url>")
  .description("Add a new registry source")
  .option("-t, --tier <tier>", "Trust tier (official|community|custom)", "community")
  .action(async (name: string, url: string, opts: { tier: string }) => {
    const paths = createPaths();
    const config = await loadSources(paths.sourcesPath);

    try {
      addSource(config, {
        name,
        url,
        tier: opts.tier as PackageTier,
        enabled: true,
      });
      await saveSources(paths.sourcesPath, config);
      console.log(`Added source "${name}" [${opts.tier}]`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

source
  .command("update")
  .description("Refresh cached package indexes from all sources (like apt update)")
  .action(async () => {
    const paths = createPaths();
    const sources = await loadSources(paths.sourcesPath);
    const results = await updateAllSources(sources, paths.cachePath);

    for (const r of results) {
      if (r.status === "ok") {
        console.log(`  ${r.name}: ${r.count} packages`);
      } else {
        console.error(`  ${r.name}: failed`);
      }
    }
  });

source
  .command("remove <name>")
  .description("Remove a registry source")
  .action(async (name: string) => {
    const paths = createPaths();
    const config = await loadSources(paths.sourcesPath);

    try {
      removeSource(config, name);
      await saveSources(paths.sourcesPath, config);
      console.log(`Removed source "${name}"`);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── Catalog commands ────────────────────────────────────────

const catalog = program
  .command("catalog")
  .description("Manage the skill/agent/prompt catalog");

catalog
  .command("list")
  .description("List catalog entries with install status")
  .action(async () => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await catalogList(paths, db);
    console.log(formatCatalogList(result));
    db.close();
  });

catalog
  .command("search <keyword>")
  .description("Search catalog by name or description")
  .action(async (keyword: string) => {
    const paths = createPaths();
    const result = await catalogSearch(paths, keyword);
    console.log(formatCatalogSearch(result));
  });

catalog
  .command("add <name>")
  .description("Add an entry to the catalog (manual or from registry)")
  .option("--from-registry", "Copy entry from community registry")
  .option("-s, --source <url>", "Source URL or path (manual mode)")
  .option("-d, --desc <description>", "Description (manual mode)")
  .option("-t, --type <type>", "Entry type (builtin|community|system|custom)", "custom")
  .option("--artifact <type>", "Artifact type (skill|agent|prompt|tool)", "skill")
  .option("--has-cli", "Skill provides CLI tooling")
  .option("--bundle", "Skill is a spec-flow bundle")
  .action(
    async (
      name: string,
      opts: {
        fromRegistry?: boolean;
        source?: string;
        desc?: string;
        type: string;
        artifact: string;
        hasCli?: boolean;
        bundle?: boolean;
      }
    ) => {
      const paths = createPaths();

      if (opts.fromRegistry) {
        // Search all configured sources for the named package
        const sources = await loadSources(paths.sourcesPath);
        const found = await findInAllSources(sources, name, paths.cachePath);

        if (!found) {
          console.error(`Error: "${name}" not found in any configured source`);
          process.exit(1);
        }

        const catalogConfig = await loadCatalog(paths.catalogPath);
        if (!catalogConfig) {
          console.error("Error: No catalog.yaml found");
          process.exit(1);
        }

        // Check if already in catalog
        if (findEntry(catalogConfig, name)) {
          console.error(`Error: "${name}" already exists in your catalog`);
          process.exit(1);
        }

        // Strip registry-specific fields to create a CatalogEntry
        const catalogEntry: CatalogEntry = {
          name: found.entry.name,
          description: found.entry.description,
          source: found.entry.source,
          type: found.entry.type,
          ...(found.entry.has_cli ? { has_cli: true } : {}),
          ...(found.entry.bundle ? { bundle: true } : {}),
          ...(found.entry.requires?.length ? { requires: found.entry.requires } : {}),
        };

        const section =
          found.artifactType === "skill"
            ? catalogConfig.catalog.skills
            : found.artifactType === "agent"
              ? catalogConfig.catalog.agents
              : found.artifactType === "tool"
                ? catalogConfig.catalog.tools
                : catalogConfig.catalog.prompts;

        section.push(catalogEntry);
        await saveCatalog(paths.catalogPath, catalogConfig);
        console.log(`Added ${found.entry.name} [${found.artifactType}] to catalog from ${found.sourceName}`);
      } else {
        // Manual add — source and desc required
        if (!opts.source || !opts.desc) {
          console.error(
            "Error: --source and --desc are required (or use --from-registry)"
          );
          process.exit(1);
        }
        const entry: CatalogEntry = {
          name,
          description: opts.desc,
          source: opts.source,
          type: opts.type as CatalogEntry["type"],
          has_cli: opts.hasCli,
          bundle: opts.bundle,
        };
        const result = await catalogAdd(
          paths,
          entry,
          opts.artifact as ArtifactType
        );
        if (result.success) {
          console.log(`Added ${result.name} [${result.artifactType}] to catalog`);
        } else {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }
      }
    }
  );

catalog
  .command("remove <name>")
  .description("Remove an entry from the catalog")
  .action(async (name: string) => {
    const paths = createPaths();
    const result = await catalogRemove(paths, name);
    if (result.success) {
      console.log(`Removed ${result.name} from catalog`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

catalog
  .command("use <name>")
  .description("Install a catalog entry (resolves dependencies)")
  .action(async (name: string) => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);
    const result = await catalogUse(paths, db, name);

    if (result.success) {
      for (const item of result.installed!) {
        console.log(`Installed ${item.name} [${item.artifactType}]`);
      }
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

catalog
  .command("sync")
  .description("Re-pull all installed catalog entries from source")
  .action(async () => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);
    const result = await catalogSync(paths, db);

    if (result.success) {
      if (!result.synced?.length) {
        console.log("No installed catalog entries to sync.");
      } else {
        for (const item of result.synced) {
          const badge = item.status === "ok" ? "ok" : `failed: ${item.error}`;
          console.log(`  ${item.name}: ${badge}`);
        }
      }
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

catalog
  .command("push <name>")
  .description("Push local changes to a catalog entry back to its source")
  .action(async (name: string) => {
    const paths = createPaths();
    const result = await catalogPush(paths, name);
    if (result.success) {
      console.log(`Pushed ${result.name} back to source`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

catalog
  .command("push-catalog")
  .description("Commit and push catalog.yaml to git remote")
  .action(async () => {
    const paths = createPaths();
    const result = await catalogPushCatalog(paths);
    if (result.success) {
      console.log("Catalog pushed to remote.");
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

program.parse();
