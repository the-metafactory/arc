## Adding a New Command (Procedure)

1. Read existing commands in src/commands/ for patterns
2. Create command file following naming convention
3. Add to command registry in cli.ts
4. Write tests using createTestEnv() -- cover: happy path, missing args, missing manifest, already installed
5. Run `bun test` -- ALL tests must pass (arc commands interact, so a new command can break existing ones)
6. Update docs/agents-md/cli-reference.md with the new command
7. Bump version in arc-manifest.yaml
