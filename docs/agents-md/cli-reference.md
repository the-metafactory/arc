## CLI Reference

### Package Management

```bash
arc install <name-or-url>     # Install from registry or direct git URL
arc list                      # List installed packages
arc list --json               # Output as JSON
arc list --type <type>        # Filter by artifact type (skill, tool, agent, prompt, component, pipeline)
arc info <name>               # Show details, capabilities, release notes
arc audit                     # Audit capability surface (summary + cross-tier warnings)
arc audit --verbose           # Full pairwise capability combination list
arc verify <name>             # Verify manifest integrity
```

### Lifecycle

```bash
arc disable <name>            # Disable (preserves repo clone)
arc enable <name>             # Re-enable a disabled package
arc remove <name>             # Completely uninstall
```

### Upgrades

```bash
arc upgrade --check           # Check for available upgrades
arc upgrade                   # Upgrade all packages
arc upgrade <name>            # Upgrade a specific package
arc self-update               # Update arc itself (git pull + bun install)
arc upgrade-core <version>    # Upgrade PAI core version (symlink management)
```

### Discovery

```bash
arc search [keyword]          # Search all configured sources (omit keyword to list all)
```

### Source Management

```bash
arc source list               # Show configured registry sources
arc source add <name> <url>   # Add a source (--tier official|community|custom)
arc source update             # Refresh indexes from all sources (like apt update)
arc source remove <name>      # Remove a source
```

### Catalog

```bash
arc catalog list              # List catalog with install status
arc catalog search [keyword]  # Search catalog by name or description
arc catalog add <name>        # Add entry (--from-registry to pull from sources)
arc catalog remove <name>     # Remove entry from catalog
arc catalog use <name>        # Install from catalog (resolves dependencies)
arc catalog sync              # Re-pull all installed catalog entries
arc catalog push <name>       # Push local changes back to source
arc catalog push-catalog      # Commit and push catalog.yaml to git remote
```

### Scaffolding

```bash
arc init <name>               # Scaffold new skill repo (default)
arc init <name> --type tool   # Scaffold tool
arc init <name> --type agent  # Scaffold agent
arc init <name> --type prompt # Scaffold prompt
arc init <name> --type pipeline # Scaffold pipeline
```
