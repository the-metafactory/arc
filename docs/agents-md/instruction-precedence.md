## Instruction Precedence

When instructions conflict, follow this priority order (highest first):

1. Security constraints (never modify user's ~/.claude without consent)
2. arc-manifest.yaml (single source of truth -- overrides code assumptions)
3. This CLAUDE.md
4. Ecosystem design decisions (from metafactory)
5. Feature specs and iteration plans
6. Runtime context (issue/PR description)
