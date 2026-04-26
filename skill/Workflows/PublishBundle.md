# PublishBundle Workflow

> Publish a built arc bundle (skill, tool, agent, or other artifact type) to the metafactory registry through the `arc bundle -> arc publish --dry-run -> confirm -> arc publish -> arc verify` round-trip. Two-phase gate at the dry-run step; halt for explicit confirmation before mutating the registry.

## When to Use

Use this workflow when:

- A package version has been bumped, the PR is merged, and the version needs to be in the registry.
- You are publishing for the first time (initial release of a new package).
- You are re-publishing after a fix-forward (new patch version of an existing package).

Do NOT use this workflow for:

- Local install testing -- use `arc install .` from the package root instead.
- Drafting a release before the PR is merged -- bundle locally if you want to inspect the tarball, but do not publish until the version commit is on the default branch.
- Deploying a cloud component -- publishing the bundle is one step; deploy is a separate workflow (see the deployment SOP for the relevant repo).

This is a **two-phase gate** (per SKILL.md § 12.6). Phase 1 (`arc publish --dry-run`) and Phase 2 (`arc publish`) run as separate sub-steps with an explicit operator confirmation in between. Do not collapse them.

## Prerequisites

Before starting:

- [ ] Working tree is clean (`git status` reports nothing uncommitted)
- [ ] You are on the default branch with the merge commit that bumps the version (`git log -1 --pretty=%s` includes the version)
- [ ] `arc-manifest.yaml` `version` field matches the release tag you intend to publish
- [ ] `bun test` passes
- [ ] You are logged in to the registry (`arc login` succeeded; bearer token is in your config)
- [ ] You have write authority for the package's namespace (org member for `official`, sponsor lined up for `community`)

---

## Steps

### 1. Pre-flight Verification

**Action:** Confirm the working tree, version, and tag are all aligned.

```bash
git status                                    # must be clean
git rev-parse --abbrev-ref HEAD               # must be the default branch
git log -1 --pretty=%s                        # last commit subject
grep "^version:" arc-manifest.yaml            # current manifest version
```

The version in `arc-manifest.yaml` must match the version you intend to publish. If the release SOP creates a tag at this point, also confirm the tag exists locally and on `origin`.

**Verify:** Manifest version matches the merge commit. `git status` is clean. You are not on a feature branch.

**Anti-pattern:** Publishing from a worktree branch. The published version must be reproducible from the default branch's commit; publishing off a branch creates an artifact that cannot be re-built later.

### 2. Build the Bundle

**Action:** Run `arc bundle` to produce the tarball.

```bash
arc bundle
```

Echo the resulting tarball path and size. Typical output:

```
Built ./dist/<name>-<version>.tgz (NN KB)
```

**Verify:** The tarball exists at the printed path. Its filename matches `<name>-<version>.tgz` where `<name>` and `<version>` come from `arc-manifest.yaml`. The size is non-zero and within the expected order of magnitude (a typical skill bundle is 10-200 KB; a tool bundle with a vendored binary may be larger).

**Anti-pattern:** Re-running `arc bundle` repeatedly without checking the output between runs. The bundle is content-addressed; if you change anything between Phase 1 and Phase 2, the sha256 will not match.

### 3. Phase 1 -- `arc publish --dry-run` (HALT FOR CONFIRMATION)

**Action:** Run `arc publish` with the dry-run flag. Capture and display the dry-run summary.

```bash
arc publish --dry-run
```

Expected output includes:

- `name`: the package name
- `version`: the version about to be published
- `scope` / `namespace`: where the package will land
- `registry target`: the registry URL it will be pushed to
- `sha256`: the bundle's content hash
- `capabilities` summary: what the package declares it needs

**Echo all of the above back to the operator verbatim.** Then write a clear, single-line halt prompt:

> **HALT.** Bundle ready for publish: `<name>@<version>` -> `<registry-target>` (sha256 `<first-12-chars>...`). Confirm publish? (yes / no)

**Verify:** The dry-run completed without errors. The sha256 is recorded (write it down, copy it to a scratch buffer, or paste it into the chat). The registry target matches the intended destination.

**Anti-pattern:** Skipping the dry-run because "I just did it last time". The dry-run is what gives you the sha256 and the scope confirmation; skipping it makes Step 6's verification impossible.

### 4. Operator Confirmation

**Action:** Wait for explicit confirmation from the operator (or the upstream agent in an agent-to-agent loop).

Acceptable confirmations: `yes`, `confirm`, `proceed`, `ship it`. Anything else (including ambiguous responses) is a deny.

If the operator denies:

- Do not publish.
- If they want to abort entirely, exit cleanly. The dry-run made no mutations; nothing to roll back.
- If they want to make a change first, exit and let them re-run the upstream workflow (likely a version-bump fix or a manifest edit). Do not loop back to Step 2 within this workflow run -- the gate is the gate.

If the operator confirms, proceed to Step 5.

**Verify:** A clear, in-band confirmation was received. It was not inferred from silence or from a non-committal phrase like "looks fine".

**Anti-pattern:** Treating "looks fine" as confirmation. The publish is irreversible (DD-14, content-addressed immutable storage); the gate exists precisely to prevent ambiguous greenlights.

### 5. Phase 2 -- `arc publish` (Real Publish)

**Action:** Run `arc publish` for real.

```bash
arc publish
```

Capture the output. Note the published bundle's sha256 -- it should match the sha256 from Step 3. If the registry returns a URL or a registry-side identifier, capture that too.

**Verify:** The publish returns a success exit code. The output reports the same `name`, `version`, and `sha256` as Step 3.

**Anti-pattern:** Re-running `arc publish` if the first attempt errors out without checking what state the registry is in. A partial publish may have already registered the version; re-publishing the same version is rejected by content-addressed storage. If you see an error, **read it** before retrying.

### 6. Verify the Round-Trip

**Action:** Confirm the published bundle on the registry has the same sha256 as the local bundle from Step 3.

```bash
arc verify <name>@<version>
```

(`arc verify` resolves the package version against the registry, downloads the bundle metadata, and reports the registered sha256.)

Compare the registered sha256 against the sha256 from Step 3. They MUST be identical.

**If they match:** the round-trip is verified. Proceed to Step 7.

**If they do not match: HALT.** This is a content-integrity failure. Do not announce. Do not promote. Do not rebuild and re-publish to "make it match" -- the registry has now recorded a sha256 that you do not control. Escalate to the metafactory steward.

**Verify:** sha256 from Step 3 == sha256 from Step 6. Both bytewise equal.

**Anti-pattern:** Announcing the publish before the verify step succeeds. If the sha256s don't match, you have just told the world a bundle is live that doesn't match what you built locally -- a supply-chain incident in slow motion.

### 7. Announce

**Action:** Post a one-liner to the relevant channel announcing the published version.

The announce message should include:

- Package name and version
- The registry URL or registry-side identifier from Step 5
- The sha256 (first 12 characters is enough for human eyes)
- A link to the release notes or CHANGELOG entry

Example:

> Published `Forge@0.1.0` to https://registry.metafactory.example/forge -- sha256 `a7f2c8e1d4b9...` -- notes: https://github.com/the-metafactory/forge/releases/tag/v0.1.0

If the package is a host-deployable component (Grove, Pulse, etc.), the announce step also signals the deploy step is unblocked. The actual deploy is a separate workflow (see deployment SOP).

**Verify:** The announcement is posted. The links in it resolve.

**Anti-pattern:** Skipping the announce. Even a one-liner matters: the team needs to know the version is live before they can install or deploy from it.

---

## Verification Checklist

After completing all steps:

- [ ] Pre-flight: working tree clean, on default branch, manifest version matches intended release
- [ ] `arc bundle` produced a tarball at the expected path
- [ ] `arc publish --dry-run` ran successfully and the sha256 was recorded
- [ ] Operator confirmation was explicit and in-band
- [ ] `arc publish` returned success and the same sha256 as the dry-run
- [ ] `arc verify` returned the same sha256 as both the dry-run and the publish
- [ ] An announcement was posted with the registry URL and sha256

## What NOT To Do

- **Do not skip the dry-run.** It is the only thing that gives you the sha256 to verify against in Step 6.
- **Do not proceed past a sha256 mismatch in Step 6.** A mismatch is a supply-chain integrity failure. Escalate; do not paper over it by re-bundling.
- **Do not collapse Phase 1 and Phase 2 into a single command** (e.g. by adding a `--yes` flag to `arc publish`). The two-phase gate exists for the human-in-the-loop pause; bypassing it defeats the design (SKILL.md § 12.6).
- **Do not publish from a feature branch.** The published version must trace to a commit on the default branch.
- **Do not re-publish the same version with different content.** Content-addressed storage rejects this (DD-14). If you need to fix-forward, bump the patch version and republish.
- **Do not announce before Step 6 passes.** Announcing a publish whose sha256 you have not verified is announcing a bundle you do not control.
