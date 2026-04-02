## Architecture

### Entry Point

- `src/cli.ts` — Main CLI entry (Commander-based). Routes all commands, manages database lifecycle.

### Commands (`src/commands/`)

| File | Command(s) | Description |
|------|-----------|-------------|
| `install.ts` | `arc install` | Install from git URL or by name from registry |
| `list.ts` | `arc list` | List installed packages (supports `--json`, `--type`) |
| `info.ts` | `arc info` | Show details, capabilities, and release notes |
| `audit.ts` | `arc audit` | Audit total capability surface with cross-tier warnings |
| `verify.ts` | `arc verify` | Verify manifest integrity of installed package |
| `disable.ts` | `arc disable` | Disable package (preserves repo clone) |
| `enable.ts` | `arc enable` | Re-enable a disabled package |
| `remove.ts` | `arc remove` | Completely uninstall a package |
| `upgrade.ts` | `arc upgrade` | Upgrade packages (supports `--check`) |
| `upgrade-core.ts` | `arc upgrade-core` | Upgrade PAI core version (symlink management) |
| `self-update.ts` | `arc self-update` | Update arc itself (git pull + bun install) |
| `init.ts` | `arc init` | Scaffold new package repo |
| `catalog.ts` | `arc catalog *` | Catalog management (list, search, add, remove, use, sync, push) |

### Libraries (`src/lib/`)

| File | Description |
|------|-------------|
| `manifest.ts` | Read and validate arc-manifest.yaml (with pai-manifest.yaml legacy fallback), risk assessment, capability formatting |
| `db.ts` | SQLite database (bun:sqlite) for installed package tracking — WAL mode, transactions for writes |
| `paths.ts` | Path resolution and directory creation. Configurable via overrides (enables test isolation) |
| `symlinks.ts` | Symlink creation/removal for skills, agents, prompts, tools. CLI shim generation for PATH-accessible tools |
| `catalog.ts` | Load/save/search catalog.yaml, dependency resolution, install-status enrichment |
| `registry.ts` | Load and search local REGISTRY.yaml files |
| `remote-registry.ts` | Fetch, cache, search, and update remote registry sources (apt-update model) |
| `sources.ts` | Manage sources.yaml configuration (add/remove/list registry sources) |
| `source-resolver.ts` | Resolve source URLs to local paths or GitHub clone URLs with branch/path extraction |
| `hooks.ts` | Register/remove Claude Code event hooks in settings.json from manifest declarations |
| `scripts.ts` | Lifecycle script runner (preinstall, postinstall, preupgrade, postupgrade) with env vars |

### Types

- `src/types.ts` — All core types: `ArcManifest`, `ArtifactType`, `Capabilities`, `InstalledSkill`, `PaiPaths`, `RegistryEntry`, `CatalogEntry`, and more.

### Data Flow

```
User command
  -> CLI routes to command handler
    -> resolve source (registry lookup or direct URL)
      -> git clone to ~/.config/arc/pkg/repos/
        -> read arc-manifest.yaml
          -> display capabilities + risk level
            -> user confirms
              -> create symlinks to ~/.claude/{skills,agents,commands,bin}/
                -> record in packages.db
                  -> run postinstall hooks (if declared)
```
