## Anti-Rationalization Rules

- Do not claim `arc install` works without running it in a test environment -- symlink creation has edge cases
- Do not assume database migrations succeed from reading the SQL -- run `bun test` with createTestEnv()
- Do not skip testing symlink cleanup in `arc remove` -- orphaned symlinks break user systems
- Do not infer catalog correctness from YAML syntax -- validate with `arc audit`
- Do not claim a command works based on the happy path -- test with missing manifests, network errors, existing installations
- Do not modify test isolation helpers (createTestEnv) without running the FULL test suite
