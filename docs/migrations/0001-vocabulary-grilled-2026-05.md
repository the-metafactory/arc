# arc — Vocabulary Migration Manifest (2026-05)

**Status:** draft for review · deterministic ground truth · **iteration 1** (first draft, awaiting review loop)
**Source:** `CONTEXT.md` (cortex) + `CONTEXT.md` (myelin) + `CONTEXT-MAP.md` (compass/ecosystem) — grill-with-docs sessions, May 2026
**Method:** every entry below was produced by `grep -rn` against `main` (commit `c4435df`, 2026-05-17). Each cited line is a real occurrence in the codebase at that commit; nothing is inferred. Where an entry depends on a decision still open, it is flagged **FOR REVIEW** and does not change a line until the decision lands.

Read this as the script: each PR claims one rename or one file/cluster, performs every listed change, runs `bunx tsc --noEmit && bun test`, opens for review.

arc is a **small** manifest — one core defect (a malformed JetStream consumer-name template) and a thin halo of `{org}` / `operator` prose. The companion myelin manifest (`myelin-migration-manifest/docs/migrations/0001-vocabulary-grilled-2026-05.md`, 4-round-reviewed) carries the heavy schema/type renames; arc consumes myelin's published grammar and must not drift from it.

---

## The core defect (read this first)

arc derives a JetStream durable-consumer name with the template:

```
cortex-review-consumer-${network}-${agent}
```

Per the **grilled cortex domain model** (`cortex/CONTEXT.md`), a JetStream consumer belongs to an **agent**, and an agent is reached via `(principal, stack, assistant)`. A **network** is *deployment topology* — "**not a subject segment**" and, by the same reasoning, **never an addressing segment** of a durable name. The wrong segment is load-bearing:

- The handover string `cortex-review-consumer-metafactory-echo` (cited at `src/lib/jetstream.ts:239`) puts `metafactory` — the **network** — in the first segment. `metafactory` is the network, not a principal. The correct first segment is the **principal** (`andreas`).
- This is the exact shape of the cortex grill's "there's the bug" dialogue: a subject built with `metafactory` where the principal belongs.
- A durable name that addresses by `(network, agent)` cannot distinguish two principals on the same network sharing one broker — every principal collides on `cortex-review-consumer-metafactory-echo`.

**The fix:** rename the template to address by `(principal, stack, assistant)`:

```
cortex-review-consumer-${principal}-${stack}-${assistant}
```

This is a deliberate three-segment widening (was two). It mirrors the subject grammar `{scope}.{principal}.{stack}.…` that myelin owns and cortex consumes. The `${agent}` segment is **also** wrong vocabulary: the bus routes to an **assistant** (`@echo`, `@sage`), and the agent is resolved from `(stack, assistant)` — it "carries no wire name" (`cortex/CONTEXT.md`, Agent entry). So `${agent}` → `${assistant}`.

This is an **operator-facing, on-the-wire change** (durable consumer names are persisted broker state). It is Tier 3. See Risk tiers and the operational re-provisioning step.

---

## Rename inventory (canonical)

| #   | Old | New | Tier | Scope | Source |
|-----|---|---|---|---|---|
| A1  | `reviewConsumerName(network, agent)` template `cortex-review-consumer-${network}-${agent}` | `cortex-review-consumer-${principal}-${stack}-${assistant}` | **3 (wire — durable name)** | code + tests + prose | cortex-CONTEXT (consumer ⊂ agent ⊂ (principal,stack,assistant)) |
| A2  | `--network` CLI flag on `arc nats provision-streams` / `provision-consumer` | `--principal` (+ new `--stack`); see flag decision | **3 (operator-facing CLI)** | code + prose | cortex-CONTEXT (network is never an addressing segment) |
| A3  | `--agent` CLI flag (the durable's being-segment) | `--assistant` | 3 (operator-facing CLI) | code + prose | cortex-CONTEXT (bus routes to assistant; agent has no wire name) |
| A4  | `{org}` subject-grammar token in comments | `{principal}` | 1 | prose (comments) | cortex-Q3 / myelin owns grammar |
| A5  | `operator` prose meaning the human / the deployment-owner | `principal` | 1 | prose (comments) | cortex-Q2 |
| A6a | `operator` prose — mechanically resolvable, every line decided here | `principal` | 1 | prose | cortex-Q2 |
| A6b | `operator` prose — genuinely ambiguous (deferred, listed) | TBD by follow-up grill | — | prose | cortex-Q2 |

### Renames this manifest does NOT make — the NSC carve-out

arc has legitimate **NSC operator-account** terminology. NSC (the NATS `nsc` CLI) models a trust hierarchy `operator → account → user`; arc's `arc nats add-bot` / `arc nats setup-operator` provision NATS users under an NSC *operator account*. This `operator` is **NATS infrastructure**, **not** the cortex `operator`-the-human concept. It is left entirely unchanged:

- **`setup-operator` command name** — `src/cli.ts:1373` `.command("setup-operator <account>")`. NSC term. Unchanged.
- **`SetupOperator*` types** — `setupOperator`, `SetupOperatorOptions`, `SetupOperatorResult`, `SetupOperatorBotResult`, `SetupOperatorJson` across `src/commands/nats.ts:551,557,563`, `src/lib/json-response.ts:102,110,112,149`, `src/cli.ts:41,50,1394,1395`. NSC API surface. Unchanged.
- **`nsc`, `nsc.json`, `NSC_NOT_INSTALLED`, `NSC_COMMAND_FAILED`** — `src/commands/nats.ts` passim, `src/lib/json-response.ts:26,27`. NSC tooling. Unchanged.
- **"operator account" prose** — `src/lib/json-response.ts:29`, `src/cli.ts:1336`, `docs/integrations/cortex-creds.md:14,34,55,57,61,133,152,153,172,175`. Every one describes an NSC operator account. Unchanged. (See A6a/A6b for the precise per-line decisions.)
- **`OP_*` account identifiers** — `OP_TEST`, `OP_LOCAL`, `OP_ATTACKER`, `OP_OTHER`, `"OP"` in `test/commands/identity.test.ts`. NSC account names. Unchanged.

### Renames FLAGGED FOR REVIEW (not made in this draft)

- **`Principal.operator` field in `src/commands/identity.ts`** — see the dedicated **FOR REVIEW: the `Principal.operator` field** section below. This field looks like myelin's `Identity.operator → .network` rename, but arc populates it from the NSC `--account` flag (`cli.ts:1531` "Operator account (used as principal.operator)"; tests set it to `OP_TEST`/`OP_LOCAL`). It is an **NSC operator account**, not the cortex network. Renaming it `.network` would be *wrong*. Renaming it `.nsc_account` may be right. **Deferred to the review loop** — no lines changed.
- **`Principal` type name / `PrincipalRegistryFile` / `principals.json`** in `src/commands/identity.ts` — myelin's R1 renames the `Principal` *type* → `Identity`. arc has a local, structurally-similar `Principal` interface (`identity.ts:21`). Whether arc's copy should track myelin's rename, or import myelin's type outright, is an **architecture question for the review loop**, not a mechanical rename. Deferred — no lines changed. (Note: arc's `Principal.type: "agent" | "service" | "operator"` at `identity.ts:26` carries the same `"operator"` literal myelin's R5 renamed to `"hub"`; same deferral applies.)

---

## The `--network` flag decision (A2 / A3)

`arc nats provision-streams` and `arc nats provision-consumer` take `--network <X>` + `--agent <Y>` and feed them straight into `reviewConsumerName`. Once A1 changes the template to `(principal, stack, assistant)`, the flags that feed it must change too — a flag named `--network` that supplies the *principal* segment is a lie on the CLI surface.

**Decision (proposed — confirm in review):**

- **Rename `--network` → `--principal`.** The flag supplies the consumer name's first segment, which is now the principal. `--network` as a name is actively misleading and must not survive.
- **Add `--stack`.** The new template has three being-segments (`principal`, `stack`, `assistant`); the CLI currently supplies only two. `--stack` is a new required option on `provision-consumer` and a new paired option on `provision-streams`.
- **Rename `--agent` → `--assistant`.** Same reasoning as A3 — the durable addresses an assistant.
- **No back-compat alias for `--network`.** Rationale: `--network` fed a *wrong* segment. An alias `--network → principal` would let an operator keep typing `--network metafactory` and silently get `cortex-review-consumer-metafactory-…` — i.e. reproduce the exact defect A1 fixes. A hard removal forces the operator to reconsider what value belongs there. The CLI is pre-1.0 surface for these subcommands (no `arc.nats.v1` schema guarantee covers *flag names*, only the `--json` payload — see `docs/integrations/cortex-creds.md:28`), so a clean break is acceptable. The PR description and `CHANGELOG.md` MUST call the removal out loudly.
- **NATS topology:** there is currently **no** separate use of `--network` for NATS leaf-node / federation topology in these commands — the flag's *only* job was the consumer-name segment. So there is nothing to "keep `--network` for". If a future federation-topology flag is needed it can be added then, cleanly named.

**FOR REVIEW:** confirm (a) hard-removal vs deprecation alias for `--network`, (b) whether `--stack` should be required or default to a sentinel, (c) `--assistant` vs keeping `--agent` as the flag name even though the segment is the assistant (the manifest recommends `--assistant` for consistency with the wire vocabulary).

---

## Per-file changes

### `src/lib/jetstream.ts` — the consumer-name source of truth (A1, A4, A5)

**Land this file first.** `reviewConsumerName` is the single point where the durable name is constructed; `src/commands/jetstream.ts` calls it. Changing the template here changes every derived name by construction.

- **A1 — the template function** (the load-bearing change):
  - L246 `export function reviewConsumerName(network: string, agent: string): string {` → `export function reviewConsumerName(principal: string, stack: string, assistant: string): string {`
  - L247 `  return \`cortex-review-consumer-${network}-${agent}\`;` → `  return \`cortex-review-consumer-${principal}-${stack}-${assistant}\`;`
- **A1 — doc comments naming the old shape:**
  - L12 ` * provisioning of CODE_REVIEW stream + \`cortex-review-consumer-<network>-<agent>\`` → `cortex-review-consumer-<principal>-<stack>-<assistant>`
  - L180 ` * \`cortex-review-consumer-<network>-<agent>\` — pilot operators picking` → `cortex-review-consumer-<principal>-<stack>-<assistant>` — **also A5/A6 prose**: "pilot operators" here means the humans running pilot → "pilot **principals**" (A6a — see prose table).
  - L181 ` * sage/echo per-network land on distinct durables.` → `sage/echo per-(principal, stack) land on distinct durables.`
  - L237 ` * Derive the canonical cortex review-consumer durable name from network +` → `… from principal,`
  - L238 ` * agent. Centralises the format so pilot's reference to` → `stack and assistant. Centralises …`
  - L239 ` * \`cortex-review-consumer-metafactory-echo\` in the P-VERIFY handover and` — **the malformed exemplar.** `metafactory` is the network. Rewrite to a correct example: `cortex-review-consumer-andreas-meta-factory-echo` (principal `andreas`, stack `meta-factory`, assistant `echo`). Add a half-sentence: "the historical `…-metafactory-echo` form was malformed — `metafactory` is the network, never an addressing segment."
  - L242 ` * Format: \`cortex-review-consumer-<network>-<agent>\`. Both segments must` → `Format: \`cortex-review-consumer-<principal>-<stack>-<assistant>\`. All three segments must`
- **A4 — `{org}` subject-grammar tokens in comments:**
  - L40 ` * Broadcast grammar \`local.{org}.{stack?}.tasks.code-review.{flavor}\` so` → `local.{principal}.{stack?}.tasks.code-review.{flavor}` — **NB:** "Broadcast grammar" — `Broadcast` is myelin's R11 / cortex-Q13 dispatch-mode rename to `Offer`. arc only references it in prose; align: "Offer grammar". Flag in A6/cross-ref to myelin R11.
  - L41 ` * the sage subscription \`local.{org}.{stack}.tasks.code-review.>\` lands` → `local.{principal}.{stack}.tasks.code-review.>`
- **A5/A6a — `operator` prose meaning the human/deployment-owner:**
  - L13 ` * durable was operator-manual. New operators hit silent timeouts because` → "durable was **principal**-manual. New **principals** hit silent timeouts …"
  - L48 ` * span every operator-id, every stack, and every code-review flavor so` → "span every **principal**, every stack, and every code-review flavor …" (the wildcard set spans principals — the subject's second segment).
  - L66 ` * operator logs surface the difference for "did I actually fix it" diagnosis.` → "**principal** logs surface the difference …"
  - L78 ` * verb invoked deliberately by the operator).` → "… deliberately by the **principal**)."
  - L133 ` * We default to leave-existing-alone — the operator changes config via` → "… the **principal** changes config via …"

### `src/commands/jetstream.ts` — the consumer-name callers (A1, A2/A3, A4, A5)

`provisionStreams` / `provisionConsumer` / `provisionConsumerInternal` thread the `(network, agent)` pair into `reviewConsumerName`. Every parameter, field, and comment on that path renames.

- **A1/A2/A3 — `ProvisionStreamsOpts.consumer`:**
  - L62 ` /** When true, \`addPerNetworkConsumer\` is also invoked for the given (network, agent) pair. */` → `… for the given (principal, stack, assistant) triple. */` — note `addPerNetworkConsumer` is a *stale name in prose* (no such function exists; the real path is `provisionConsumerInternal`). Rewrite to: "When set, a per-(principal, stack, assistant) consumer is also provisioned."
  - L63 ` consumer?: { network: string; agent: string };` → `consumer?: { principal: string; stack: string; assistant: string };`
- **A1 — `provisionStreams` doc + call:**
  - L69 ` * Provision the CODE_REVIEW stream and optionally a per-(network, agent)` → `… per-(principal, stack, assistant)`
  - L115 `        opts.consumer.network,` → `opts.consumer.principal,`
  - **add** a line passing the new stack segment: `opts.consumer.stack,`
  - L116 `        opts.consumer.agent,` → `opts.consumer.assistant,`
- **A1/A2/A3 — `ProvisionConsumerOpts`:**
  - L134 ` /** Network segment of the consumer name (\`cortex-review-consumer-<network>-<agent>\`). */` → ` /** Principal segment of the consumer name (\`cortex-review-consumer-<principal>-<stack>-<assistant>\`). */`
  - L135 ` network: string;` → ` principal: string;`
  - **add** ` /** Stack segment of the consumer name. */` + ` stack: string;`
  - L136 ` /** Agent segment of the consumer name. */` → ` /** Assistant segment of the consumer name. */`
  - L137 ` agent: string;` → ` assistant: string;`
- **A1 — `provisionConsumer` doc + call:**
  - L145 ` * Provision a single per-(network, agent) durable consumer on an existing` → `… per-(principal, stack, assistant) durable consumer …`
  - L169 `      opts.network,` → `opts.principal,`
  - **add** `opts.stack,`
  - L170 `      opts.agent,` → `opts.assistant,`
- **A1 — `provisionConsumerInternal`:**
  - L186-191 signature `async function provisionConsumerInternal(jsm, stream, network: string, agent: string, filterSubject?: string)` → `(jsm, stream, principal: string, stack: string, assistant: string, filterSubject?: string)`
  - L193 `  const durable = reviewConsumerName(network, agent);` → `reviewConsumerName(principal, stack, assistant);`
- **A5/A6a — `operator` prose:**
  - L7 ` * those three layers make a fresh-operator install reach a state where` → "… make a fresh-**principal** install reach a state where" (a fresh install by a principal).
  - L12 ` *   - First-install: run after broker comes up to create CODE_REVIEW + per-agent durables` → "per-**assistant** durables" (the durable is the assistant's; A3 vocabulary).

### `src/cli.ts` — the operator-facing flags (A2, A3)

The `provision-streams` and `provision-consumer` subcommands. Every `--network` / `--agent` flag, its description, its options-object type, and the paired-flag validation rename. Per the flag decision: `--network`→`--principal`, add `--stack`, `--agent`→`--assistant`.

- **`provision-streams` (L1451–1487):**
  - L1456 `  .option("--network <network>", "Network segment of the consumer name (with --agent)")` → `.option("--principal <principal>", "Principal segment of the consumer name (with --stack and --assistant)")`
  - **add** `.option("--stack <stack>", "Stack segment of the consumer name")`
  - L1457 `  .option("--agent <agent>", "Agent segment of the consumer name (with --network)")` → `.option("--assistant <assistant>", "Assistant segment of the consumer name (with --principal and --stack)")`
  - L1459 action type `{ natsUrl?: string; stream?: string; network?: string; agent?: string; json?: boolean }` → `{ …; principal?: string; stack?: string; assistant?: string; json?: boolean }`
  - L1460 `if ((opts.network && !opts.agent) || (!opts.network && opts.agent)) {` → the all-or-none guard now spans **three** flags. Replace with a check that `principal`, `stack`, `assistant` are either all present or all absent: `const segs = [opts.principal, opts.stack, opts.assistant]; if (segs.some(Boolean) && !segs.every(Boolean)) {`
  - L1461 `const msg = "--network and --agent must be supplied together";` → `"--principal, --stack and --assistant must be supplied together";`
  - L1472 `...(opts.network && opts.agent && { consumer: { network: opts.network, agent: opts.agent } }),` → `...(opts.principal && opts.stack && opts.assistant && { consumer: { principal: opts.principal, stack: opts.stack, assistant: opts.assistant } }),`
- **`provision-consumer` (L1489–1520):**
  - L1491 `  .description("Idempotently create a per-(network, agent) durable consumer on the CODE_REVIEW stream")` → `… per-(principal, stack, assistant) durable consumer …`
  - L1492 `  .requiredOption("--network <network>", "Network segment of the consumer name")` → `.requiredOption("--principal <principal>", "Principal segment of the consumer name")`
  - **add** `.requiredOption("--stack <stack>", "Stack segment of the consumer name")`
  - L1493 `  .requiredOption("--agent <agent>", "Agent segment of the consumer name")` → `.requiredOption("--assistant <assistant>", "Assistant segment of the consumer name")`
  - L1498-1502 action type `{ network: string; agent: string; natsUrl?: string; … }` → `{ principal: string; stack: string; assistant: string; natsUrl?: string; … }`
  - L1503-1505 `const callOpts = { network: opts.network, agent: opts.agent, … }` → `{ principal: opts.principal, stack: opts.stack, assistant: opts.assistant, … }`

### `test/unit/jetstream.test.ts` — consumer-name + orchestrator tests (A1)

Every `reviewConsumerName` call, every `provisionStreams`/`provisionConsumer` `consumer:`/option object, and every expected durable string. The expected strings move from 2-segment to 3-segment.

- **`reviewConsumerName` describe block:**
  - L49 `test("composes the canonical cortex-review-consumer-<network>-<agent> format", …)` → `… <principal>-<stack>-<assistant> format`
  - L50 `expect(reviewConsumerName("metafactory", "echo")).toBe("cortex-review-consumer-metafactory-echo");` → `expect(reviewConsumerName("andreas", "meta-factory", "echo")).toBe("cortex-review-consumer-andreas-meta-factory-echo");` — **NB: replace the `metafactory`-first-segment fixture with a correct `(principal, stack, assistant)` triple.** This test currently *encodes the bug as the expected behaviour*; it must be rewritten, not just re-typed.
  - L51 `expect(reviewConsumerName("local", "sage")).toBe("cortex-review-consumer-local-sage");` → `expect(reviewConsumerName("andreas", "work", "sage")).toBe("cortex-review-consumer-andreas-work-sage");`
- **`ensureConsumer` durable fixtures** — L115, L119, L131 use `"cortex-review-consumer-net-echo"`. These exercise `ensureConsumer` directly (a generic durable-name passthrough — not derived via `reviewConsumerName`), so they are not strictly part of A1. **Recommend** updating the literal to a well-formed `cortex-review-consumer-andreas-meta-factory-echo` for consistency so no reader copies the malformed `-net-echo` shape. Low-risk cosmetic; flag in review.
- **`provisionStreams orchestrator`:**
  - L148 `test("happy path: stream + per-(network, agent) consumer both created", …)` → `… per-(principal, stack, assistant) consumer …`
  - L152 `consumer: { network: "metafactory", agent: "echo" },` → `consumer: { principal: "andreas", stack: "meta-factory", assistant: "echo" },`
  - L159 `name: "cortex-review-consumer-metafactory-echo",` → `name: "cortex-review-consumer-andreas-meta-factory-echo",`
  - L172 `consumer: { network: "metafactory", agent: "echo" },` → `consumer: { principal: "andreas", stack: "meta-factory", assistant: "echo" },`
  - L178 `test("no consumer when caller omits the {network, agent} pair", …)` → `… omits the {principal, stack, assistant} triple`
- **`provisionConsumer orchestrator`:**
  - L219 `test("derives the canonical durable name from (network, agent)", …)` → `… from (principal, stack, assistant)`
  - L229-230 `network: "metafactory", agent: "echo",` → `principal: "andreas", stack: "meta-factory", assistant: "echo",`
  - L233 `expect(capturedDurable).toBe("cortex-review-consumer-metafactory-echo");` → `… "cortex-review-consumer-andreas-meta-factory-echo"`
  - L234 `expect(r.resource.name).toBe("cortex-review-consumer-metafactory-echo");` → same new string
  - L248-249 `network: "net-a", agent: "echo",` → `principal: "andreas", stack: "meta-factory", assistant: "echo",`

### `src/lib/source-resolver.ts` — `org` — NO CHANGE (carve-out)

`org` appears at L10, L11, L44, L47, L53, L57, L61, L73, L74, L83, L86, L91, L95, L99, L111, L112 — every one is a **GitHub URL path segment** (`https://github.com/{org}/{repo}`). GitHub's `org` is a real, correct term for a GitHub organisation; it is **not** the cortex `{org}` subject token. **No change.** Same for `org` in `src/commands/catalog.ts:319,354,594,745`, `src/lib/artifact-installer.ts:347`, and `org?: string` on the `Source` type (`src/types.ts:72`) — all GitHub-org metadata. Listed here so a reviewer sees they were considered and deliberately excluded.

---

## FOR REVIEW: the `Principal.operator` field (`src/commands/identity.ts`)

This is the single genuinely-ambiguous cluster. **No lines are changed in this draft.** The review loop must decide.

The facts:

- `src/commands/identity.ts:21-29` defines a local `Principal` interface with `operator: string;` (L24) and `type: "agent" | "service" | "operator"` (L26).
- `arc identity generate` populates `Principal.operator` from the `-a, --account` flag — `src/cli.ts:1531` describes it verbatim as `"Operator account (used as principal.operator)"`.
- Tests confirm the values are NSC account names: `OP_TEST` (`identity.test.ts:46,55`), `OP_LOCAL` / `OP_ATTACKER` (`:105,110,118`), `OP_OTHER` (`:127`), `"OP"` (`:143`).
- `loadRegistry` validates it (`identity.ts:55` `principals[${index}].operator: required`) and `importPrincipals` uses it for a security check (`:214-219` cross-operator key-overwrite rejection).

**Why this is NOT a mechanical `operator → network` rename:**

- myelin's manifest renames `Identity.operator → .network` because in myelin that field held *the org that runs the hub*. arc's field holds an **NSC operator account** — `OP_TEST`, an NATS trust-hierarchy node. Renaming it `.network` would assert "metafactory" where the data is "OP_TEST". That is factually wrong and would break the `importPrincipals` security check's semantics.
- The cross-operator-overwrite test (`identity.test.ts:103` "rejects cross-operator key overwrite") is an **NSC-account** security boundary. It belongs to the NSC carve-out.

**Options for the review loop:**

1. **Rename `Principal.operator → Principal.nsc_account`** (and `type: "operator"` literal review separately). Most honest: the field *is* an NSC account. Touches `identity.ts` (interface + validator + 4 prose uses), `identity.test.ts` (6 uses), `cli.ts:1531`. This is a **config-file-format change** — `principals.json` on disk carries the `operator` key; a rename needs a back-compat read window (accept both `operator` and `nsc_account`, emit only the new key, bump a registry version).
2. **Leave `Principal.operator` unchanged**, treat it as part of the NSC carve-out, and only document the distinction. Cheapest; defensible since it genuinely is NSC vocabulary.
3. **Adopt myelin's `Identity` type wholesale** — delete arc's local `Principal` and import `Identity` from the myelin package. Largest change; correct long-term; depends on myelin's R1 landing first and on whether myelin's `Identity` models an NSC account at all (it does not — myelin's `.network` ≠ NSC account). Likely *rejected* on that mismatch.

**Manifest recommendation:** option 1 or 2 — **not** option 3, and **never** `operator → network` here. Carried to the review loop as the headline open question. The same deferral covers the `Principal` type-name rename and the `type: "operator"` string literal (`identity.ts:26,56`, `identity.test.ts` `type: "agent"` fixtures are unaffected).

---

## `operator` prose — the A6 line-by-line resolution

Every `operator` occurrence in arc, classified. **A6a** = mechanically resolved here. **A6b** = deferred. **NSC** = carve-out, no change.

### A6a — resolved to `principal` (the human / deployment-owner)

| File:Line | Old fragment | New |
|---|---|---|
| `src/lib/jetstream.ts:13` | "durable was operator-manual. New operators hit…" | "principal-manual. New principals hit…" |
| `src/lib/jetstream.ts:48` | "span every operator-id, every stack…" | "span every principal, every stack…" |
| `src/lib/jetstream.ts:66` | "operator logs surface the difference…" | "principal logs surface…" |
| `src/lib/jetstream.ts:78` | "verb invoked deliberately by the operator)." | "…by the principal)." |
| `src/lib/jetstream.ts:133` | "the operator changes config via…" | "the principal changes config via…" |
| `src/lib/jetstream.ts:180` | "pilot operators picking sage/echo…" | "pilot principals picking sage/echo…" |
| `src/commands/jetstream.ts:7` | "make a fresh-operator install reach…" | "make a fresh-principal install reach…" |
| `src/lib/symlinks.ts:29` | "operator-owned state, so install must too." | "principal-owned state…" |
| `src/commands/init.ts:61` | "silent clobber of operator content" | "…of principal content" |
| `src/commands/init.ts:84` | "arc never overwrites operator [content]" | "arc never overwrites principal [content]" |
| `docs/agents-md/core-concepts.md:17` | "operator intent wins over auto-bootstrap." | "principal intent wins…" |
| `src/types.ts:230` | "surprise operators with custom install paths" | "surprise principals with custom install paths" |
| `src/types.ts:232` | "of overriding operator intent." | "of overriding principal intent." |
| `src/types.ts:365` | "the install chain — not the operator — is…" | "…not the principal…" |
| `src/lib/nats-broker.ts:18` | "that would need root and surprise operators…" | "…surprise principals…" |
| `src/lib/nats-broker.ts:21` | "The operator [must resolve]…" | "The principal…" |
| `src/lib/nats-broker.ts:116` | "operator-supplied URLs with embedded credentials" | "principal-supplied URLs…" |
| `src/lib/nats-broker.ts:172` | "Operators piping stderr into log [files]…" | "Principals piping stderr…" |
| `src/lib/nats-broker.ts:207` | "True when NATS_URL was set… (operator-specified remote)." | "(principal-specified remote)." |
| `src/lib/nats-broker.ts:383` | "operators who keep nats-server in a non-package location" | "principals who keep nats-server…" |
| `src/lib/nats-broker.ts:414` | "operators that install via the OS package" | "principals that install via the OS package" |
| `src/lib/hosts/darwin-launchd.ts:22` | "operator runbook tools on a server" | "principal runbook tools…" |
| `src/lib/hosts/cortex.ts:25` | "Operators on a fresh install" | "Principals on a fresh install" |
| `src/commands/remove.ts:61` | "the operator can investigate and retry." | "the principal can investigate…" |
| `src/commands/remove.ts:96` | "surfaced to the operator [as warnings]" | "surfaced to the principal" |
| `src/commands/remove.ts:175` | "the operator can clean up manually." | "the principal can clean up…" |
| `src/commands/remove.ts:402` | "operator may have replaced an arc-installed file" | "principal may have replaced…" |
| `src/commands/remove.ts:456` | "surfaced via a console warning so an operator who has…" | "…so a principal who has…" |
| `src/commands/remove.ts:474` | "leave it for the operator to inspect" | "leave it for the principal to inspect" |
| `src/commands/install.ts:856` | "so an operator on macOS doesn't see…" | "so a principal on macOS…" |
| `src/commands/upgrade.ts:208` | "operator sees both. Without preHeadSha…" | "principal sees both…" |
| `src/commands/catalog.ts:32` | "drift there reflects real operator intent." | "…real principal intent." |
| `src/commands/catalog.ts:549` | "which would clobber operator state." | "…clobber principal state." |
| `src/lib/registry-install.ts:196` | "the reason field is operator-typed text on the other side" | **A6b — see below** |

### A6b — deferred (genuinely ambiguous)

| File:Line | Fragment | Why deferred |
|---|---|---|
| `src/lib/registry-install.ts:196` | "the marketplace `reason` field is operator-typed text on the other side" | "operator" here = whoever *authored the marketplace listing* — could be a third-party publisher, not the local principal. Not clearly the human-who-runs-arc. Needs a grill: is "marketplace operator" a `principal`, a `publisher`, or its own term? |
| `src/lib/registry-install.ts:202` | "the other end is the marketplace operator — the operator can be compromised" | Same "marketplace operator" concept — the *adversary model* names a remote party. Renaming to `principal` would wrongly imply the local human. Deferred with `registry-install.ts:196`. |

### NSC — no change (carve-out, listed for completeness)

`src/lib/json-response.ts:29`; `src/cli.ts:1336,1373,1394,1395`; `src/commands/nats.ts:4,5,255,551,557,563,566,567,571,573,615,616,646`; `src/lib/json-response.ts:102,110,112,149`; `docs/integrations/cortex-creds.md:14,34,55,57,61,133,152,153,172,175`; `test/commands/identity.test.ts` `OP_*` values. All NSC operator-account terminology. Plus `src/lib/hooks.ts:169` ("shell redirect/pipe operator") — that is a *programming-language operator*, unrelated to either sense; no change.

---

## Risk tiers

**Tier 1 — internal / prose only.** Comment + doc-string text. No wire, no API, no persisted format. Safe in a single PR, validated by `tsc` + `bun test` (tests only fail if a renamed *identifier* leaked — pure prose cannot break the build). Covers: A4, A5, A6a.

**Tier 3 — operator-facing CLI + persisted broker state.** A1, A2, A3. Two compounding reasons this is the top tier despite being a "small" repo:

1. **Durable consumer names are persisted broker state.** A JetStream durable created as `cortex-review-consumer-metafactory-echo` does **not** rename itself when arc's template changes. After the A1 PR ships, `arc nats provision-consumer` will create `cortex-review-consumer-andreas-meta-factory-echo` — a *different, new* durable. The old malformed durable lingers, still bound to its filter subject, still accumulating acks. See the operational step below.
2. **`--network` is operator muscle-memory.** Operators and any scripts/runbooks calling `arc nats provision-streams --network … --agent …` break the moment A2/A3 land. This is a deliberate break (the flag fed a wrong value) but it is a break — `CHANGELOG.md` and the PR body must headline it.

There is **no Tier 2** in arc: there is no envelope-schema or shared-wire-payload change here (those all live in the myelin manifest). The `principals.json` config-format question is contained inside the deferred `Principal.operator` cluster — if the review loop chooses to rename that field it becomes a Tier-2 change *at that point*, handled by that follow-up.

---

## PR ordering

Small repo — three PRs, strictly ordered.

1. **PR-1 — A1 + A4 + A5 (jetstream cluster).** `src/lib/jetstream.ts` + `src/commands/jetstream.ts` + `test/unit/jetstream.test.ts`. The template rename, its one caller path, and its tests, landed atomically so `bun test` stays green. Includes the `{org}`→`{principal}` and `operator`→`principal` prose *within those two files only* (A4/A5 lines local to jetstream). This PR makes `reviewConsumerName` correct.
   - **Blocks PR-2:** the CLI flags must feed the new 3-arg `reviewConsumerName`; PR-2 will not compile until PR-1's signature change is in.
2. **PR-2 — A2 + A3 (CLI flags).** `src/cli.ts` only. Rename `--network`→`--principal`, add `--stack`, `--agent`→`--assistant`, the three-flag all-or-none guard. `CHANGELOG.md` entry under `### Changed` headlining the flag break. Depends on PR-1.
3. **PR-3 — A6a (remaining `operator` prose).** Every A6a line *outside* the jetstream files — `nats-broker.ts`, `remove.ts`, `install.ts`, `upgrade.ts`, `catalog.ts`, `symlinks.ts`, `init.ts`, `types.ts`, `hosts/*.ts`, `core-concepts.md`. Pure-prose, independent, can land any time after PR-1 (no ordering constraint with PR-2; sequenced last only to keep review small).

**Deferred — not in this manifest's PR set:** the `Principal.operator` cluster (FOR REVIEW section) and the A6b marketplace-operator lines. Each becomes its own follow-up issue once the review loop decides.

---

## Roll-out

1. **PR-1 merges.** `reviewConsumerName` now emits `cortex-review-consumer-{principal}-{stack}-{assistant}`. No live broker is touched yet — arc only *constructs* names; it does not rename existing durables.
2. **Operational step — re-provision the malformed durables (REQUIRED, manual).** Any broker that already has `cortex-review-consumer-metafactory-*` durables (created by the pre-fix arc, cited in the P-VERIFY handover as `cortex-review-consumer-metafactory-echo`) carries **orphaned, malformed** durables after PR-1. They will not self-heal. For each affected broker/account:
   - Enumerate: `nats consumer ls CODE_REVIEW` (or `nats stream view`) and identify every `cortex-review-consumer-metafactory-*` name.
   - Re-provision the correct durable: `arc nats provision-consumer --principal <principal> --stack <stack> --assistant <assistant>` (post-PR-2 flag names).
   - **Cut over consumers**, then delete the stale durable: `nats consumer rm CODE_REVIEW cortex-review-consumer-metafactory-echo`. Do **not** delete before the new durable is consuming — JetStream redelivers un-acked messages, and dropping the old durable mid-flight loses in-flight review tasks.
   - This step is a runbook item, not code — add it to the cortex/pilot deployment SOP and the PR-1 description. It is the arc analogue of the myelin manifest's schema-cutover discipline.
3. **PR-2 merges.** CLI flags cut over. Announce in the release notes: `arc nats provision-* --network` is **removed**; use `--principal --stack --assistant`. Any automation (cortex bootstrap scripts, CI fixtures, the `docs/integrations/cortex-creds.md` runbook if it grows a provisioning example) updates in the same window.
4. **PR-3 merges.** Prose-only; no roll-out action.
5. **Follow-up grills** (post-manifest): the `Principal.operator` field decision, the `Principal` type-name question, and the A6b marketplace-operator lines. Each lands as its own issue + PR with its own (possibly Tier-2) discipline.

### Cross-manifest consistency

arc consumes the subject grammar myelin owns. Two alignment points the review loop must check against the myelin manifest:

- **`Broadcast`/`broadcast` → `Offer`/`offer`** (myelin R11). arc references "Broadcast grammar" only in a `jetstream.ts:40` comment — fixed under A4's note. arc has no `broadcast` *enum value* (that is myelin's). If myelin's R11 changes the dispatch-mode vocabulary, arc's one prose mention must match.
- **`{org}` → `{principal}`** (myelin grammar / cortex-Q3). arc's A4 changes arc's *comments*; myelin owns the *grammar definition*. These must land describing the same token shape.

No arc PR should merge a grammar-token spelling that contradicts the myelin manifest at its merge commit.
