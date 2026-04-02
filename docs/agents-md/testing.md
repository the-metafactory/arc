## Testing

arc uses `bun test` with three test categories:

```bash
bun test                    # All tests
bun test:unit               # Unit tests (test/unit/)
bun test:commands           # Command tests (test/commands/)
bun test:e2e                # End-to-end lifecycle tests (test/e2e/)
```

### Test Categories

**Unit tests** (`test/unit/`): Pure function tests for libraries.
- `catalog.test.ts`, `db.test.ts`, `hooks.test.ts`, `manifest.test.ts`, `paths.test.ts`, `registry.test.ts`, `remote-registry.test.ts`, `source-resolver.test.ts`, `sources.test.ts`

**Command tests** (`test/commands/`): Integration tests for CLI commands.
- `audit.test.ts`, `catalog.test.ts`, `disable.test.ts`, `init.test.ts`, `install.test.ts`, `lifecycle-hooks.test.ts`, `list.test.ts`, `remove.test.ts`, `upgrade-core.test.ts`, `upgrade.test.ts`, `verify.test.ts`

**E2E tests** (`test/e2e/`): Full lifecycle tests.
- `lifecycle.test.ts`

### Test Isolation

All tests use `createTestEnv()` from `test/helpers/test-env.ts`. This creates:
- Isolated temp directories simulating the full arc directory structure
- A fresh SQLite database
- Configurable `PaiPaths` pointing to the temp dirs
- A `cleanup()` function that closes the DB and removes the temp dir

Mock skill repos are created via `createMockSkillRepo()` which scaffolds a git-initialized repo with arc-manifest.yaml.

**Critical:** Tests must NEVER touch real `~/.claude/` or `~/.config/`. The `createTestEnv()` helper enforces this by providing overridden paths.
