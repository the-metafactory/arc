## Implementation Workflow

arc uses `blueprint.yaml` for feature tracking with the prefix convention `A-{seq}` (e.g., A-100, A-201).

**Workflow:**
```
1. Check what's ready: blueprint ready
2. Claim the feature: blueprint update arc:<id> --status in-progress
3. Create feature branch: feat/{slug} (e.g., feat/list-json-output)
4. Implement with tests
5. PR -> review -> merge to main
6. Mark done: blueprint update arc:<id> --status done
7. Validate graph: blueprint lint
```

**Branch naming:** `feat/{slug}`, `fix/{slug}`, `chore/{slug}`, `docs/{slug}`, `test/{slug}`

**Conventional commits:** `feat:`, `fix:`, `chore:`, `docs:`, `test:` prefixes.

**Blueprint statuses:** `planned`, `in-progress`, `done` are settable. `ready`, `blocked`, `next` are computed from dependency graph. Cross-repo dependencies use `repo:id` format (e.g., `meta-factory:F2-200`).
