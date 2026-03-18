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
import { homedir } from "os";
import { join } from "path";

const pkg = require("../package.json");

const program = new Command();

program
  .name("pai-pkg")
  .description("PAI skill package manager")
  .version(pkg.version);

program
  .command("install <repo-url>")
  .description("Install a skill from a git repository")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (repoUrl: string, opts: { yes?: boolean }) => {
    const paths = createPaths();
    await ensureDirectories(paths);
    const db = openDatabase(paths.dbPath);

    const result = await install({ paths, db, repoUrl, yes: opts.yes });

    if (result.success) {
      console.log(`\n✅ Installed ${result.name} v${result.version}`);
    } else {
      console.error(`\n❌ ${result.error}`);
      process.exit(1);
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
  .action(() => {
    const paths = createPaths();
    const db = openDatabase(paths.dbPath);
    const result = audit(db);
    console.log(formatAudit(result));
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
  .command("init <name>")
  .description("Scaffold a new skill repo")
  .option("-d, --dir <path>", "Target directory")
  .option("-a, --author <name>", "Author GitHub username")
  .action(async (name: string, opts: { dir?: string; author?: string }) => {
    const targetDir =
      opts.dir ?? `./${`pai-skill-${name.replace(/^_/, "").toLowerCase()}`}`;
    const result = await init(targetDir, name, opts.author);

    if (result.success) {
      console.log(`\n✅ Scaffolded skill at ${result.path}`);
      console.log(`\nFiles created:`);
      for (const f of result.files!) {
        console.log(`  ${f}`);
      }
    } else {
      console.error(`\n❌ ${result.error}`);
      process.exit(1);
    }
  });

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

program.parse();
