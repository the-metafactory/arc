# Arc sequential fix plan: #196, #183, #184

Date: 2026-06-03

## Operating rules

- Work issues in this exact order: #196, #183, #184.
- Use a fresh branch from `origin/main` for each issue.
- Keep scratch and body files inside this repo when needed; do not write temporary task artifacts under `/tmp`.
- Use TDD: add a failing behavior test first, implement the smallest fix, then refactor if needed.
- Verify each issue locally with focused tests, `rtk bunx tsc --noEmit`, `rtk bun run lint`, and `rtk bun test`.
- Open a PR, wait for GitHub CI, run Sage review via `sage dispatch`, fix any blockers/majors, then merge.
- Leave unrelated untracked files untouched.

## Queue

### 1. #196 - publish submission status

Goal: `arc publish` must not report unconditional `Published` when MetaFactory returns a review submission status.

Expected implementation:
- Preserve `submission_id` and `submission.status` from version registration responses.
- Surface pending review as uploaded/queued, including submission id.
- Surface rejected submissions clearly, including review comment when present.
- Keep approved/no-submission legacy responses as `Published`.

Verification:
- Unit tests for `registerVersion()` response parsing.
- Command tests for formatted pending/rejected publish output.

### 2. #183 - idempotent hook registration

Goal: repeated install/upgrade must leave exactly one hook registration per package/event/matcher/command.

Expected implementation:
- Replace package-owned hook registrations rather than appending duplicates.
- Reconcile old untagged duplicates matching the same event/matcher/command.
- Preserve unrelated hook entries.

Verification:
- Install/upgrade hook tests showing repeated runs do not duplicate hooks.
- Regression test for untagged duplicate cleanup.

### 3. #184 - tarball upgrade and check

Goal: registry/tarball installs upgrade without `git pull`, and `--check` reports available registry upgrades.

Expected implementation:
- Detect tarball-extracted installs and use registry download/replace path.
- Keep git installs on the existing git path.
- Ensure `--check` resolves scoped registry package versions correctly.

Verification:
- Tests for tarball upgrade from older installed version to newer registry version.
- Tests for `arc upgrade <name> --check` reporting the available newer version.

