## Tool Policy

- File reading -> Read tool (never cat)
- Search -> Grep/Glob (never find/bash grep)
- Testing -> `bun test` (always run full suite for arc -- commands interact)
- Test isolation -> Always use createTestEnv() (never test against real ~/.config/metafactory)
- Manifest validation -> Read + validate against schema (never assume YAML structure)
- Package database -> bun:sqlite via library functions (never raw SQL in commands)
- If `arc install` fails in tests -> check symlink permissions, path resolution, AND database state
