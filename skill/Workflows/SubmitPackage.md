# SubmitPackage Workflow

> Prepare and submit an existing package to the metafactory registry, ensuring all governance, quality, and trust requirements are met.

## Prerequisites

Before starting:
- [ ] Package has been developed and tested locally
- [ ] `arc install .` works from the package root (local install test)
- [ ] Package has at least one passing test (`bun test`)
- [ ] Git history is clean (`git status` shows no uncommitted changes)

---

## Steps

### 1. Run the Verification Checklist

**Action:** Go through every item in the SKILL.md Verification Checklist (Section 11). Do not skip items. Do not assert pass without running the actual check.

Run these commands and capture output:
```bash
# Manifest validation
cat arc-manifest.yaml | head -20

# Tests
bun test

# Type checking (if TypeScript)
bun run typecheck

# Lint (if configured)
bun run lint

# Blueprint (if ecosystem project)
blueprint lint
```

**Verify:** Every item in the checklist passes. If any fail, fix them before proceeding.

**Anti-pattern:** Do not proceed with failures "planning to fix later." Fix now. The reviewer will find them.

### 2. Check Trust Tier Requirements

**Action:** Determine which trust tier applies to this submission.

| Submitter | Tier | Additional Requirement |
|-----------|------|----------------------|
| metafactory founder | core/official | Design authority approval |
| the-metafactory org member | official | Standard PR review |
| Community contributor | community | Sponsor required (DD-9) |
| Private/local use | custom | No submission needed |

For **community** submissions:
- You need a sponsor at PROVEN tier or above
- The sponsor co-signs your submission
- Namespace must be `@your-github-username/package-name`

**Verify:** You know your tier and have a sponsor lined up (if community).

### 3. Verify Package Signing Readiness

**Action:** Ensure the package can be signed.

For packages published through GitHub Actions (recommended):
- GitHub OIDC provides keyless signing via Sigstore
- Your repo must have GitHub Actions enabled
- The workflow must produce a reproducible build

For manual publication:
- cosign must be installed (`cosign version`)
- You must be able to sign the bundle

**Verify:** `arc bundle` produces a tarball. The tarball's SHA-256 hash is stable across runs (reproducible build).

### 4. Prepare the PR

**Action:** Create a PR with signal-rich content. The PR is the package's first impression on reviewers.

#### Branch Setup

```bash
# Ensure you're on a feature branch, not main
git branch --show-current  # Must NOT be "main"

# If on main, create a branch
git worktree add ../{repo}-submit -b feat/initial-submission main
```

#### PR Body Template

Write the PR body with this structure:

```markdown
## Summary

- [What the package does in 1-2 sentences]
- [Why it exists, what problem it solves]
- [Package type and trust tier]

## Package Details

| Field | Value |
|-------|-------|
| Name | `{name}` |
| Version | `{version}` |
| Type | `{type}` |
| Tier | `{tier}` |
| License | `{license}` |
| Namespace | `{namespace}` |

## Capabilities Requested

```yaml
filesystem:
  read: [list actual paths]
  write: [list actual paths]
network: [list actual URLs]
bash:
  allowed: true|false
secrets: [list actual env vars]
```

## Test Results

```
$ bun test
[paste actual output]
```

## Verification Checklist

- [x] arc-manifest.yaml validates (schema: arc/v1)
- [x] bun test passes (N/N green)
- [x] bun run typecheck: zero errors
- [x] CLAUDE.md generated from compass template
- [x] No secrets in repo
- [x] Capabilities are minimal and justified
- [x] bundle.exclude set correctly
- [x] [additional items as relevant]

## Blueprint Status (if applicable)

- {ID}: planned -> in-progress

## Sponsor (community tier only)

Sponsored by: @{sponsor-github-username}
```

**Verify:** The PR body contains all sections. Test output is real (not fabricated). Checklist items were actually verified.

**Anti-pattern:** Do not write "all tests pass" in the checklist without pasting the actual test output. The reviewer should see the evidence.

### 5. Create the PR

**Action:** Push and create the PR.

```bash
git push -u origin $(git branch --show-current)
gh pr create --title "{name} v{version}: {short description}" --body "$(cat <<'EOF'
[PR body from step 4]
EOF
)"
```

Apply labels:
```bash
gh pr edit --add-label "feature,now"
```

**Verify:** PR is created and visible. Labels are applied.

### 6. Wait for Review (Agent Steps Out)

**Action:** Once the PR is created and a human reviewer engages, the agent's job is done. The review is human-to-human.

The agent's role was to make the PR so well-documented that the reviewer can assess quality without round-trip questions. If the reviewer asks questions, a human (the author) should respond.

**Why:** LLMs are sycophantic in feedback cycles. They don't push back effectively against reviewer suggestions, even when the reviewer is wrong. Human judgment in review must be preserved.

**Exception:** The agent may be asked to make mechanical fixes (typos, formatting) identified in review. But design feedback stays human-to-human.

---

## Post-Merge Steps

After the PR is approved and merged:

### 7. Bump Version

Follow the versioning SOP:
```bash
# For initial submission, version is already 0.1.0
# For subsequent updates:
# feat: -> minor bump (0.1.0 -> 0.2.0)
# fix: -> patch bump (0.1.0 -> 0.1.1)
```

Update `arc-manifest.yaml` version field.

### 8. Update Blueprint

```bash
blueprint update {repo}:{ID} --status done
blueprint lint
```

### 9. Register in Registry (If Official)

For official packages published to the metafactory registry:
```bash
arc bundle
arc publish
```

This creates a signed, content-addressed package in the registry.

---

## Verification Checklist

After completing submission:

- [ ] PR exists with signal-rich body (summary, capabilities, test results, checklist)
- [ ] PR has correct labels (type + priority)
- [ ] Tests were run and output is in the PR
- [ ] Capabilities are minimal and justified
- [ ] Sponsor is identified (community tier)
- [ ] Branch is not main
- [ ] No secrets in the diff
- [ ] Post-merge: version bumped
- [ ] Post-merge: blueprint updated
- [ ] Post-merge: package published (if applicable)

## What NOT To Do

- Do not submit a PR without running the verification checklist first. Every "easy fix" that skips verification costs a review cycle.
- Do not fabricate test output. Paste the actual terminal output.
- Do not keep the agent in the review loop. Once a human reviewer engages, the agent steps out.
- Do not submit with overly broad capabilities "just in case." Reviewers will ask why, and "I might need it later" is not acceptable.
- Do not submit without a sponsor if you're at community tier. The PR will be closed.
- Do not force-push after review has started. Add fixup commits instead.
