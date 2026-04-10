#!/usr/bin/env bun

import { Command } from "commander";
import { createPaths, ensureDirectories } from "./lib/paths.js";
import { openDatabase } from "./lib/db.js";
import { install } from "./commands/install.js";
import { list, formatList, formatListJson } from "./commands/list.js";
import { info, formatInfo, formatInfoJson } from "./commands/info.js";
import { audit, formatAudit } from "./commands/audit.js";
import { disable } from "./commands/disable.js";
import { enable } from "./commands/enable.js";
import { remove, removeLibrary } from "./commands/remove.js";
import { verify, formatVerify } from "./commands/verify.js";
import { init } from "./commands/init.js";
import { upgradeCore, formatUpgrade } from "./commands/upgrade-core.js";
import { selfUpdate, formatSelfUpdate, checkSelfUpdate, formatSelfUpdateCheck } from "./commands/self-update.js";
import {
  checkUpgrades,
  upgradePackage,
  upgradeAll,
  upgradeLibrary,
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
import type { CatalogEntry, ArtifactType, PackageTier, RegistrySource, SourceType } from "./types.js";
import { loadCatalog, saveCatalog, findEntry } from "./lib/catalog.js";
import {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  formatSourceList,
  validateSource,
} from "./lib/sources.js";
import {
  searchAllSources,
  findInAllSources,
  updateAllSources,
  formatSourcedSearch,
} from "./lib/remote-registry.js";
import { homedir } from "os";
import { join } from "path";
import { parseLibraryRef } from "./lib/artifact-installer.js";

const pkg = require("../package.json");

const program = new Command();

program
  .name("arc")
  .description("Agentic component package manager")
  .version(pkg.version);

program
  .command("install <name-or-url>")
  .description("Install a skill from git URL, or by name from the registry")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (nameOrUrl: string, opts: { yes?: boolean }) => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);

    // Parse library:artifact colon syntax (only for non-URL names)
    const isUrl =
      nameOrUrl.includes("/") ||
      nameOrUrl.startsWith("git@") ||
      nameOrUrl.startsWith("http");

    let libraryName: string | undefined;
    let artifactName: string | undefined;
    let lookupName = nameOrUrl;

    if (!isUrl) {
      const libRef = parseLibraryRef(nameOrUrl);
      if (libRef?.artifactName) {
        libraryName = libRef.libraryName;
        artifactName = libRef.artifactName;
        lookupName = libRef.libraryName;
      }
    }

    if (isUrl) {
      // Direct git install
      const result = await install({ paths, db, repoUrl: nameOrUrl, yes: opts.yes, artifactName });
      if (result.success) {
        if (result.artifacts?.length) {
          console.log(`\n✅ Installed ${result.artifacts.filter(a => a.success).length} artifact(s) from ${result.name}`);
        } else {
          console.log(`\n✅ Installed ${result.name} v${result.version}`);
        }
      } else {
        console.error(`\n❌ ${result.error}`);
        process.exit(1);
      }
    } else {
      // Name-based: search all configured sources → install
      const sources = await loadSources(paths.sourcesPath);
      const found = await findInAllSources(sources, lookupName, paths.cachePath);

      if (!found) {
        console.error(`❌ "${lookupName}" not found in any source. Try: arc search <keyword>`);
        process.exit(1);
      }

      console.log(`Found ${lookupName} [${found.artifactType}] in ${found.sourceName} [${found.sourceTier}]`);

      // Install directly from the source URL
      const result = await install({
        paths,
        db,
        repoUrl: found.entry.source,
        yes: opts.yes,
        sourceName: found.sourceName,
        sourceTier: found.sourceTier,
        artifactName,
        libraryName,
      });
      if (result.success) {
        if (result.artifacts?.length) {
          console.log(`✅ Installed ${result.artifacts.filter(a => a.success).length} artifact(s) from ${result.name}`);
        } else {
          console.log(`✅ Installed ${result.name} v${result.version}`);
        }
      } else {
        console.error(`❌ ${result.error}`);
        process.exit(1);
      }
    }

    db.close();
  });

program
  .command("list")
  .description("List installed packages")
  .option("--json", "Output as JSON")
  .option("--type <type>", "Filter by artifact type (skill, tool, agent, prompt, pipeline, rules)")
  .option("--library <name>", "Filter by library name")
  .action((opts: { json?: boolean; type?: string; library?: string }) => {
    const validTypes = ["skill", "tool", "agent", "prompt", "component", "pipeline", "rules", "action"];
    if (opts.type && !validTypes.includes(opts.type)) {
      console.error(`\n❌ Unknown type "${opts.type}". Valid types: ${validTypes.join(", ")}`);
      process.exit(1);
    }
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = list(db, { type: opts.type as ArtifactType | undefined, library: opts.library });
    console.log(opts.json ? formatListJson(result) : formatList(result));
    db.close();
  });

program
  .command("info <name>")
  .description("Show details about a package (installed or from registry)")
  .option("--json", "Output as JSON")
  .action(async (name: string, opts: { json?: boolean }) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = await info(db, name, paths);
    console.log(opts.json ? formatInfoJson(result) : formatInfo(result));
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
  .description("Completely uninstall a skill (supports library:artifact syntax)")
  .option("--library <name>", "Remove all artifacts from a library")
  .action(async (name: string, opts: { library?: string }) => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);

    if (opts.library) {
      // Remove all artifacts from a library
      const { listByLibrary } = await import("./lib/db.js");
      const libArtifacts = listByLibrary(db, opts.library);
      if (libArtifacts.length) {
        for (const art of libArtifacts) {
          const result = await remove(db, paths, art.name);
          if (result.success) {
            console.log(`🗑️  Removed ${result.name}`);
          }
        }
      } else {
        console.error(`❌ No artifacts found for library '${opts.library}'`);
        process.exit(1);
      }
    } else {
      // Parse library:artifact syntax
      const libRef = parseLibraryRef(name);
      const removeName = libRef?.artifactName ?? name;

      const result = await remove(db, paths, removeName);

      if (result.success) {
        console.log(`🗑️  Removed ${result.name}`);
      } else {
        // Artifact not found — check if name matches a library
        const libResult = await removeLibrary(db, paths, removeName);
        if (libResult.success) {
          console.log(`🗑️  Removed ${libResult.removedCount} artifact(s) from library '${removeName}'`);
        } else {
          console.error(`❌ ${libResult.error}`);
          process.exit(1);
        }
      }
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
  .option("--force", "Re-run upgrade pipeline even if already at latest version")
  .action(async (name: string | undefined, opts: { check?: boolean; force?: boolean }) => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);

    if (opts.check || (!name && !opts.force)) {
      // Check mode or upgrade-all (without force): first show what's available
      const checks = await checkUpgrades(db, paths);

      if (opts.check) {
        // Also check if arc itself has an update
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
    } else if (!name && opts.force) {
      // Force upgrade all
      const results = await upgradeAll(db, paths, { force: true });
      if (!results.length) {
        console.log("No packages installed.");
      } else {
        console.log(formatUpgradeResults(results, { force: true }));
      }
    } else {
      // name is guaranteed non-null here — commander validates required args for single-package paths
      const libRef = parseLibraryRef(name!);
      let upgradeName = libRef?.artifactName ?? name!;
      let isLibraryUpgrade = false;

      if (!libRef?.artifactName) {
        // No colon — check if name matches a library
        const { listByLibrary } = await import("./lib/db.js");
        const libArtifacts = listByLibrary(db, name!);
        if (libArtifacts.length > 0) {
          isLibraryUpgrade = true;
        }
      }

      if (isLibraryUpgrade) {
        const results = await upgradeLibrary(db, paths, name!, { force: opts.force });
        console.log(formatUpgradeResults(results, { force: opts.force }));
      } else {
        const result = await upgradePackage(db, paths, upgradeName, { force: opts.force });
        if (result.success) {
          if (result.oldVersion === result.newVersion) {
            if (opts.force) {
              console.log(`${result.name}: force-upgraded at ${result.oldVersion}`);
            } else {
              console.log(`${result.name} is already at ${result.oldVersion}`);
            }
          } else {
            console.log(`${result.name}: ${result.oldVersion} → ${result.newVersion}`);
          }
        } else {
          console.error(`${result.error}`);
          process.exit(1);
        }
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
    "Artifact type: skill, tool, agent, prompt, pipeline (default: skill)"
  )
  .action(
    async (
      name: string,
      opts: { dir?: string; author?: string; type?: string }
    ) => {
      const validTypes = ["skill", "tool", "agent", "prompt", "pipeline"] as const;
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

      const prefix = `arc-${artifactType}`;
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
  .description("Update arc itself (git pull + bun install)")
  .action(async () => {
    const result = await selfUpdate();
    console.log(formatSelfUpdate(result));
    if (!result.success) process.exit(1);
  });

// ── Registry search (top-level) ─────────────────────────────

program
  .command("search [keyword]")
  .description("Search all configured sources (omit keyword to list all)")
  .action(async (keyword?: string) => {
    const paths = createPaths();
    const sources = await loadSources(paths.sourcesPath);
    const results = await searchAllSources(sources, keyword ?? "", paths.cachePath);
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
  .option("--type <type>", "Source type (registry|metafactory)", "registry")
  .action(async (name: string, url: string, opts: { tier: string; type: string }) => {
    const paths = createPaths();
    const config = await loadSources(paths.sourcesPath);

    const newSource: RegistrySource = {
      name,
      url,
      tier: opts.tier as PackageTier,
      enabled: true,
      ...(opts.type !== "registry" ? { type: opts.type as SourceType } : {}),
    };

    const validation = validateSource(newSource);
    if (!validation.valid) {
      console.error(`Error: ${validation.error}`);
      process.exit(1);
    }

    try {
      addSource(config, newSource);
      await saveSources(paths.sourcesPath, config);
      console.log(`Added source "${name}" [${opts.tier}] (${opts.type})`);
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
  .command("search [keyword]")
  .description("Search catalog (omit keyword to list all)")
  .action(async (keyword?: string) => {
    const paths = createPaths();
    const result = await catalogSearch(paths, keyword ?? "");
    console.log(formatCatalogSearch(result));
  });

catalog
  .command("add <name>")
  .description("Add an entry to the catalog (manual or from registry)")
  .option("--from-registry", "Copy entry from community registry")
  .option("-s, --source <url>", "Source URL or path (manual mode)")
  .option("-d, --desc <description>", "Description (manual mode)")
  .option("-t, --type <type>", "Entry type (builtin|community|system|custom)", "custom")
  .option("--artifact <type>", "Artifact type (skill|agent|prompt|tool|pipeline)", "skill")
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
