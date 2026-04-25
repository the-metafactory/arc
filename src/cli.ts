#!/usr/bin/env bun

import { Command } from "commander";
import { createPaths, ensureDirectories } from "./lib/paths.js";
import { openDatabase } from "./lib/db.js";
import { install, parseNameVersion } from "./commands/install.js";
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
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { bundle, formatBundle } from "./commands/bundle.js";
import { publish, formatPublish } from "./commands/publish.js";
import {
  reviewList,
  reviewShow,
  reviewApprove,
  reviewReject,
  reviewRequestChanges,
  formatReviewList,
  formatReviewShow,
  formatReviewAction,
} from "./commands/review.js";
import {
  searchAcrossSources,
  formatSearch,
  formatSearchJson,
  formatWarnings,
  parseArtifactType,
  parsePackageTier,
} from "./commands/search.js";
import {
  parsePackageRef,
  formatPackageRef,
  resolveFromRegistry,
  downloadPackage,
  verifyChecksum,
  extractPackage,
} from "./lib/registry-install.js";
import { verifyVersionSignature } from "./lib/registry-signing.js";
import { verifyPackageSigstore } from "./lib/cosign-verify.js";
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
  findInAllSources,
  updateAllSources,
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
  .option("--pin <version>", "Pin to a specific version (git tag)")
  .action(async (nameOrUrl: string, opts: { yes?: boolean; pin?: string }) => {
    // Non-TTY guard: fail loud rather than silently half-installing
    if (!opts.yes && !process.stdin.isTTY) {
      console.error("Error: arc install requires an interactive terminal for capability confirmation.");
      console.error("Pass --yes (-y) to approve non-interactively.");
      process.exit(1);
    }

    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);

    // Check if input is a registry package ref (@scope/name[@version])
    const pkgRef = parsePackageRef(nameOrUrl);

    // Parse library:artifact colon syntax (only for non-URL names)
    const isUrl =
      nameOrUrl.startsWith("git@") ||
      nameOrUrl.startsWith("http") ||
      nameOrUrl.startsWith("file://");

    let libraryName: string | undefined;
    let artifactName: string | undefined;
    // Validate --pin flag: must look like semver (same check as @version suffix)
    if (opts.pin && !/^v?\d+\.\d+/.test(opts.pin)) {
      console.error(`Invalid version "${opts.pin}". Expected semver (e.g., 1.2.0).`);
      process.exit(1);
    }
    let pinnedVersion: string | undefined = opts.pin?.replace(/^v/, "");
    let lookupName = nameOrUrl;

    if (!isUrl && !pkgRef) {
      // Check for version suffix: MySkill@1.2.0
      const nameVer = parseNameVersion(nameOrUrl);
      if (nameVer) {
        pinnedVersion ??= nameVer.version;
        lookupName = nameVer.name;
      }

      const libRef = parseLibraryRef(lookupName);
      if (libRef?.artifactName) {
        libraryName = libRef.libraryName;
        artifactName = libRef.artifactName;
        lookupName = libRef.libraryName;
      }
    }

    if (pkgRef) {
      // Registry install: @scope/name[@version] → download from metafactory API
      const sources = await loadSources(paths.sourcesPath);
      const resolved = await resolveFromRegistry(pkgRef, sources.sources);

      if (!resolved) {
        console.error(`Package "${formatPackageRef(pkgRef)}" not found in any metafactory registry.`);
        console.error(`Try: arc search ${pkgRef.name}`);
        process.exit(1);
      }

      console.log(`Found ${formatPackageRef(pkgRef)} v${resolved.version} in ${resolved.source.name} [${resolved.source.tier}]`);

      // Download. Anonymous by default (DD-80); the resolved source is passed
      // through so an auth-gated metafactory storage endpoint receives the
      // bearer token from `arc login` (issue #83).
      console.log(`Downloading...`);
      const download = await downloadPackage(resolved.downloadUrl, paths.reposDir, resolved.source);
      if (!download.success || !download.tempPath) {
        console.error(`${download.error}`);
        process.exit(1);
      }
      console.log(`Downloaded ${(download.bytesDownloaded! / 1024).toFixed(0)} KB`);

      // Verify SHA-256
      const verify = await verifyChecksum(download.tempPath, resolved.sha256);
      if (!verify.valid) {
        console.error(`Checksum verification failed!`);
        console.error(`  Expected: ${verify.expected}`);
        console.error(`  Actual:   ${verify.actual}`);
        console.error(`This could indicate a corrupted download or compromised package.`);
        await Bun.file(download.tempPath).exists() && Bun.spawnSync(["rm", "-f", download.tempPath]);
        process.exit(1);
      }
      console.log(`SHA-256 verified`);

      // A-504: verify registry-level Ed25519 signature over manifest bytes.
      // Blocks install on any verified=false. verified=null means the
      // version is unsigned (legacy / registry in degraded mode at publish
      // time) — arc proceeds with a warning, consistent with meta-factory's
      // own graceful degradation.
      const sigResult = await verifyVersionSignature(
        resolved.source,
        {
          registry_signature: resolved.registrySignature,
          registry_key_id: resolved.registryKeyId,
        },
        resolved.manifestCanonical,
      );
      if (sigResult.verified === false) {
        // Distinguish infrastructure unavailability from a genuine
        // signature mismatch. Both fail-closed, but the user-facing
        // framing differs: "try again later" vs "investigate now".
        const infraFailure = /public key unavailable|manifest_canonical missing/i.test(
          sigResult.reason,
        );
        console.error(`Registry signature verification failed: ${sigResult.reason}`);
        if (infraFailure) {
          console.error(`The registry may be temporarily unreachable or misconfigured. Try again later.`);
        } else {
          console.error(`This could indicate a compromised registry or a tampered manifest.`);
        }
        await Bun.file(download.tempPath).exists() && Bun.spawnSync(["rm", "-f", download.tempPath]);
        process.exit(1);
      }
      if (sigResult.verified === true) {
        console.log(`Registry signature verified (${sigResult.reason})`);
      } else {
        console.warn(`Registry signature: ${sigResult.reason}`);
      }

      // A-503: verify Sigstore bundle (cosign) when signature_bundle_key is
      // present. Scope OQ-14: GitHub Actions OIDC only. verified=null means
      // the version predates Sigstore signing — proceed with a warning.
      const sigstoreResult = await verifyPackageSigstore({
        source: resolved.source,
        sha256: resolved.sha256,
        signing: {
          signature_bundle_key: resolved.signatureBundleKey,
          signer_identity: resolved.signerIdentity,
        },
        artifactPath: download.tempPath,
        tempDir: paths.reposDir,
      });
      if (sigstoreResult.verified === false) {
        console.error(`Sigstore verification failed: ${sigstoreResult.reason}`);
        console.error(`This could indicate a tampered artifact or an unexpected signer.`);
        await Bun.file(download.tempPath).exists() && Bun.spawnSync(["rm", "-f", download.tempPath]);
        process.exit(1);
      }
      if (sigstoreResult.verified === true) {
        console.log(`Sigstore signature verified (${sigstoreResult.reason})`);
      } else {
        console.warn(`Sigstore signature: ${sigstoreResult.reason}`);
      }

      // Extract
      const packageDir = `${resolved.scope}__${resolved.name}`;
      const extract = await extractPackage(download.tempPath, paths.reposDir, packageDir);
      if (!extract.success) {
        console.error(`${extract.error}`);
        process.exit(1);
      }

      // Continue with standard install flow (manifest, symlinks, hooks, DB).
      // Use preExtractedPath so install() skips git clone.
      const result = await install({
        paths,
        db,
        repoUrl: formatPackageRef({ scope: resolved.scope, name: resolved.name, version: resolved.version }),
        yes: opts.yes,
        preExtractedPath: extract.extractedPath,
        sourceName: resolved.source.name,
        sourceTier: resolved.source.tier,
      });
      if (result.success) {
        console.log(`Installed ${result.name} v${result.version} (verified)`);
      } else {
        console.error(`${result.error}`);
        process.exit(1);
      }
    } else if (isUrl) {
      // Direct git install
      const result = await install({ paths, db, repoUrl: nameOrUrl, yes: opts.yes, artifactName, pinnedVersion });
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
        console.error(`"${lookupName}" not found in any source. Try: arc search <keyword>`);
        process.exit(1);
      }

      const versionLabel = pinnedVersion ? ` (pinned: v${pinnedVersion})` : "";
      console.log(`Found ${lookupName} [${found.artifactType}] in ${found.sourceName} [${found.sourceTier}]${versionLabel}`);

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
        pinnedVersion,
      });
      if (result.success) {
        if (result.artifacts?.length) {
          console.log(`✅ Installed ${result.artifacts.filter(a => a.success).length} artifact(s) from ${result.name}`);
        } else {
          console.log(`✅ Installed ${result.name} v${result.version}`);
        }
      } else {
        console.error(`${result.error}`);
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
  .option("--json", "Output as JSON for machine consumption")
  .option("--type <type>", "Filter by artifact type (skill, tool, agent, prompt, component, pipeline, action)")
  .option("--tier <tier>", "Filter by source tier (official, community, custom)")
  .action(async (keyword: string | undefined, opts: { json?: boolean; type?: string; tier?: string }) => {
    const paths = createPaths();
    const sources = await loadSources(paths.sourcesPath);

    // Validate filters
    let typeFilter;
    if (opts.type) {
      typeFilter = parseArtifactType(opts.type);
      if (!typeFilter) {
        console.error(`Error: invalid --type "${opts.type}". Valid: skill, tool, agent, prompt, component, pipeline, action`);
        process.exit(1);
      }
    }
    let tierFilter;
    if (opts.tier) {
      tierFilter = parsePackageTier(opts.tier);
      if (!tierFilter) {
        console.error(`Error: invalid --tier "${opts.tier}". Valid: official, community, custom`);
        process.exit(1);
      }
    }

    const result = await searchAcrossSources(sources, paths.cachePath, {
      keyword,
      type: typeFilter,
      tier: tierFilter,
    });

    // Emit warnings to stderr
    const warnings = formatWarnings(result);
    if (warnings) console.error(warnings);

    if (opts.json) {
      console.log(formatSearchJson(result));
    } else {
      console.log(formatSearch(result));
    }
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

// ── Auth commands ──────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with metafactory registry (required for publishing only)")
  .option("-s, --source <name>", "Target source name (default: first metafactory source)")
  .option("-f, --force", "Re-authenticate even if already logged in")
  .action(async (opts: { source?: string; force?: boolean }) => {
    const paths = createPaths();
    const result = await login({ paths, sourceName: opts.source, force: opts.force });

    if (result.success) {
      console.log(`Logged in to ${result.sourceName}`);
      if (result.scope) console.log(`  Scope: ${result.scope}`);
      if (result.expiresAt) console.log(`  Expires: ${new Date(result.expiresAt * 1000).toISOString()}`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Remove authentication from metafactory source (only affects publishing)")
  .option("-s, --source <name>", "Target source name (default: first metafactory source)")
  .action(async (opts: { source?: string }) => {
    const paths = createPaths();
    const result = await logout({ paths, sourceName: opts.source });

    if (result.success) {
      console.log(`Logged out from ${result.sourceName}`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

// ── Bundle and publish commands ────────────────────────────

program
  .command("bundle [path]")
  .description("Create a distributable tarball from a package directory. For monorepos, pass a subdirectory (e.g. `arc bundle packages/my-pkg`) or use the library pattern at the repo root.")
  .option("-o, --output <path>", "Output path for the tarball")
  .action(async (path: string | undefined, opts: { output?: string }) => {
    const paths = createPaths();
    const result = await bundle({
      paths,
      packageDir: path ?? process.cwd(),
      outputPath: opts.output,
    });

    console.log(formatBundle(result));
    if (!result.success) process.exit(1);
  });

program
  .command("publish [path]")
  .description("Publish a package to the metafactory registry")
  .option("-t, --tarball <path>", "Publish from existing tarball (skip bundling)")
  .option("--dry-run", "Validate and show what would be published without uploading")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--scope <namespace>", "Override publish scope/namespace")
  .action(async (path: string | undefined, opts: { tarball?: string; dryRun?: boolean; source?: string; scope?: string }) => {
    const paths = createPaths();
    const result = await publish({
      paths,
      packageDir: path ?? process.cwd(),
      tarballPath: opts.tarball,
      dryRun: opts.dryRun,
      sourceName: opts.source,
      scope: opts.scope,
    });

    console.log(formatPublish(result));
    if (!result.success) process.exit(1);
  });

// ── Review commands (sponsor/steward triage) ────────────────

const review = program
  .command("review")
  .description("Review pending package submissions (sponsor/steward)");

review
  .command("list")
  .description("List pending submissions assigned to you")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("-p, --page <number>", "Page number", "1")
  .option("--per-page <number>", "Items per page (max 100)", "20")
  .option("--json", "Output raw JSON")
  .action(async (opts: { source?: string; page: string; perPage: string; json?: boolean }) => {
    const paths = createPaths();
    const result = await reviewList({
      paths,
      sourceName: opts.source,
      page: parseInt(opts.page, 10) || 1,
      perPage: parseInt(opts.perPage, 10) || 20,
      json: opts.json,
    });
    console.log(formatReviewList(result));
    if (!result.success) process.exit(1);
  });

review
  .command("show <id>")
  .description("Show submission detail")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; json?: boolean }) => {
    const paths = createPaths();
    const result = await reviewShow({ paths, sourceName: opts.source, id, json: opts.json });
    console.log(formatReviewShow(result));
    if (!result.success) process.exit(1);
  });

review
  .command("approve <id>")
  .description("Approve a submission")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; json?: boolean }) => {
    const paths = createPaths();
    const result = await reviewApprove({ paths, sourceName: opts.source, id, json: opts.json });
    console.log(formatReviewAction(result));
    if (!result.success) process.exit(1);
  });

review
  .command("reject <id>")
  .description("Reject a submission (requires --reason)")
  .requiredOption("-r, --reason <text>", "Rejection reason (shown to publisher)")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; reason: string; json?: boolean }) => {
    const paths = createPaths();
    const result = await reviewReject({
      paths,
      sourceName: opts.source,
      id,
      reason: opts.reason,
      json: opts.json,
    });
    console.log(formatReviewAction(result));
    if (!result.success) process.exit(1);
  });

review
  .command("request-changes <id>")
  .description("Request changes from publisher (requires --message)")
  .requiredOption("-m, --message <text>", "Change request comment (shown to publisher)")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; message: string; json?: boolean }) => {
    const paths = createPaths();
    const result = await reviewRequestChanges({
      paths,
      sourceName: opts.source,
      id,
      comment: opts.message,
      json: opts.json,
    });
    console.log(formatReviewAction(result));
    if (!result.success) process.exit(1);
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
