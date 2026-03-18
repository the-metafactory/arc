# PAI Skill Security Architecture

> Runtime enforcement for distributed AI skills. How to prevent malicious SKILL.md instructions from causing harm — using infrastructure that already exists.

**Status:** Design specification (companion to [DESIGN.md](DESIGN.md) and [RESEARCH.md](RESEARCH.md))
**Scope:** Runtime enforcement, observability, and integration architecture. Does NOT cover transport, signing, or governance (see DESIGN.md for those layers).

---

## 1. The Enforcement Gap

PAI's existing design describes three layers: Transport, Trust, and Governance. DESIGN.md specifies capability declarations in `pai-manifest.yaml` and mentions "runtime enforcement" as a future item. RESEARCH.md's red team analysis identified the critical finding:

> Without a tool-call firewall, the entire security model is theater. Signing proves WHO published a skill, not WHETHER it's safe. Capability declarations without enforcement are documentation, not security.

The Steffen025 security review of pai-collab's trust model confirmed this independently:

> **CRITICAL:** Layer 2 (tool-restricted sandboxing) described but not implemented — patterns are Layer 1 only.

**The gap is not architectural — it's implementation.** The enforcement mechanism already exists in PAI as `SecurityValidator.hook.ts`, a `PreToolUse` hook that evaluates YAML-based security patterns against every tool call in <10ms. It currently enforces global rules (blocked commands, zero-access paths, read-only paths). It just doesn't know about skills.

---

## 2. Existing Foundation

### 2.1 SecurityValidator.hook.ts (The Proto-Firewall)

PAI already intercepts every `Bash`, `Read`, `Write`, and `Edit` tool call through a `PreToolUse` hook. The hook:

- Receives `{tool_name, tool_input, session_id}` as JSON on stdin
- Loads security patterns from `patterns.yaml` (YAML, not code)
- Evaluates patterns against the tool call arguments
- Returns one of: `allow`, `block` (exit 2), `ask` (user confirmation), `alert` (log)
- Executes in <10ms (pure pattern matching, no I/O beyond initial config load)
- Logs all security events to `MEMORY/SECURITY/` for audit trail

**This IS the tool-call firewall.** It implements the exact model recommended by the research: deterministic YAML policy evaluation at the tool-call boundary with no LLM in the security path.

### 2.2 patterns.yaml (The Policy Engine)

The current schema supports:

```yaml
bash:
  trusted: [{pattern, reason}]    # Fast-path allow
  blocked: [{pattern, reason}]    # Hard block (exit 2)
  confirm: [{pattern, reason}]    # User confirmation required
  alert:   [{pattern, reason}]    # Log but allow
paths:
  zeroAccess: [path]              # Never readable or writable
  readOnly:   [path]              # Readable, not writable
  confirmWrite: [path]            # Write requires confirmation
  noDelete:   [path]              # Cannot be deleted
```

### 2.3 pai-collab Security Stack (Shipped)

Three spoke repos provide complementary security layers:

| Project | Maintainer | What It Does | Layer |
|---------|-----------|--------------|-------|
| **pai-secret-scanning** | @jcfischer | Outbound: blocks commits containing API keys (8 custom gitleaks rules) | Pre-commit + CI |
| **pai-content-filter** | @jcfischer | Inbound: detects prompt injection in loaded content (34 patterns, 389 tests) | Content boundary |
| **skill-enforcer** | @jcfischer | Structure: validates skill format, ensures customizations load | Skill invocation |

### 2.4 Arbor Security Kernel (Reference Architecture)

Arbor (`~/Developer/arbor/`) implements a 5-layer authorization pipeline in Elixir/OTP with Ed25519 identity, self-verifying capabilities, and a hierarchical resource URI scheme. While Arbor runs as a standalone Elixir system (not directly portable to Claude Code), its design patterns map cleanly to the hook model:

| Arbor Layer | Purpose | Claude Code Equivalent |
|-------------|---------|----------------------|
| Layer 0: Identity Verification | Ed25519 signed request envelopes | SkillSeal signature verification at install time |
| Layer 1: Capability Check | Hierarchical URI matching | `patterns.yaml` pattern matching in SecurityValidator |
| Layer 2: Constraint Enforcement | Rate limits, time windows, quotas | Hook-based counters (future) |
| Layer 3: Trust Gate | Capabilities linked to trust tier | Install-time tier policy (`sources.yaml`) |
| Layer 4: Consensus Escalation | Multi-perspective evaluation | Human review for Community/Official tiers |

Arbor's resource URI scheme maps directly to Claude Code tools:

```
arbor://fs/read/{path}       → Read tool  (file_path argument)
arbor://fs/write/{path}      → Write/Edit tool (file_path argument)
arbor://shell/exec/{command} → Bash tool  (command argument)
arbor://net/http/{url}       → WebFetch tool (url argument)
arbor://agent/spawn          → Agent tool (spawning subagents)
```

---

## 3. Design: Skill-Scoped Policy Enforcement

### 3.1 Core Insight

The key first-principles insight: **the SecurityValidator doesn't need to know which skill is active.** It enforces the UNION of all policies. When `pai-pkg install` runs, it reads the skill's `pai-manifest.yaml` capabilities and merges them into the global `patterns.yaml` as a skill-contributed policy section. When `pai-pkg disable` runs, it removes them.

```
Install = add policy rules
Disable = remove policy rules
The hook stays global — it enforces whatever patterns.yaml contains
```

This avoids the hardest problem (runtime skill attribution) entirely.

### 3.1.1 Known Limitation: Union Model Permissiveness

**Conscious architectural tradeoff, documented per community review (JC, 2026-03-18).**

The union model means every installed skill operates within the combined capability surface of ALL installed skills. A malicious SKILL.md can exploit capabilities declared by other installed skills without declaring its own. This is the "capability piggybacking" problem.

**Why we accept this for Phase 1:**
- Per-skill isolation requires **runtime skill attribution** — knowing which skill triggered each tool call. Claude Code's hook payload provides `tool_name` and `tool_input` but not skill origin. This is a platform constraint, not a design choice.
- The union model is simple, auditable, and predictable. The alternative (parsing conversation history to infer skill context) is fragile and adds ~50ms of transcript I/O per PreToolUse call.
- With <50 skills in the ecosystem, the union surface is bounded and manageable.

**Mitigations (all shipping in Phase 1):**
1. **Zero declared = zero granted.** A skill that declares no capabilities in its `pai-manifest.yaml` gets no implicit permissions from the union. This prevents the "free-rider" attack where a minimal skill exploits the union surface.
2. **Capability delta display.** `pai-pkg install` shows what NEW combined capabilities this install creates, not just the skill's own capabilities.
3. **Expanded composition warnings.** `pai-pkg audit` flags all dangerous compositions including `secrets + network` (data exfiltration), not just `network + write`.
4. **Publish-time SKILL.md analysis** (Phase 2). Registry-side static analysis scans SKILL.md for tool references inconsistent with declared capabilities (e.g., skill declares no network but references `curl`).

**Gate for revisiting:** If Claude Code exposes skill-level tool attribution in its hook payload, per-skill isolation becomes feasible and should be implemented. Track: [Anthropic hook API evolution].

### 3.2 Extended patterns.yaml Schema

```yaml
version: "2.0"
philosophy:
  mode: defense-in-depth
  principle: "Skill capabilities are additive. Base rules always apply."

# ── Base Security (always active, cannot be overridden by skills) ──
base:
  bash:
    blocked:
      - pattern: "rm\\s+-rf\\s+/"
        reason: "Recursive delete of root filesystem"
      - pattern: "curl.*\\|.*sh"
        reason: "Pipe remote script to shell"
    confirm:
      - pattern: "git\\s+push\\s+--force"
        reason: "Force push may destroy remote history"
  paths:
    zeroAccess:
      - "~/.ssh/"
      - "~/.gnupg/"
      - "~/.aws/credentials"
      - "~/.config/pai/secrets/"
    readOnly:
      - "/etc/"
      - "/usr/"
      - "~/.claude/hooks/"                    # Security hooks are immutable
      - "~/.claude/PAI/USER/PAISECURITYSYSTEM/"  # Security policy is immutable

# ── Skill Policies (managed by pai-pkg install/disable) ──
skills:
  ExtractWisdom:
    installed: "2026-03-18"
    manifest_hash: "sha256:a1b2c3..."
    capabilities:
      filesystem:
        read:
          - "~/.claude/skills/PAI/USER/"
          - "~/.claude/MEMORY/WORK/"
        write:
          - "~/.claude/MEMORY/WORK/"
      network:
        allowed_domains:
          - "api.openai.com"
      bash:
        allowed_patterns:
          - "bun\\s+Tools/ExtractWisdom\\.ts"
      secrets:
        - "OPENAI_API_KEY"

  MyCustomSkill:
    installed: "2026-03-20"
    manifest_hash: "sha256:d4e5f6..."
    capabilities:
      filesystem:
        read:
          - "~/.claude/MEMORY/"
        write: []
      network:
        allowed_domains: []
      bash:
        allowed_patterns: []
      secrets: []
```

### 3.2.1 Migration from v1.0 to v2.0

The existing patterns.yaml has no `version` field and no `skills:` section. Migration is automatic and backward-compatible:

```
Detection: if no `version` key in parsed YAML → v1 format
Migration:
  1. Insert `version: "2.0"` at top
  2. Wrap existing content under `base:` section
  3. Add empty `skills: {}` section
  4. Write migrated file back
  5. If no patterns.yaml exists, behavior is unchanged (no skill policies)
```

### 3.2.2 Manifest Hash Integrity Verification

Each skill policy in `patterns.yaml` includes a `manifest_hash` field (SHA-256 of the installed `pai-manifest.yaml`). On every SecurityValidator load:

1. For each skill in `skills:`, compute current hash of the installed skill's `pai-manifest.yaml`
2. Compare against recorded `manifest_hash`
3. On mismatch: skill was modified post-install → log security event + set skill policy to `suspended` (most restrictive — no capabilities until re-verified)
4. On match: proceed normally

This catches post-install tampering (e.g., attacker modifies a skill's manifest to declare additional capabilities after the user approved the original).

### 3.3 Enforcement Logic

The extended SecurityValidator evaluates tool calls against the merged policy:

```typescript
// Pseudocode for extended SecurityValidator enforcement

function evaluateToolCall(tool: string, input: ToolInput): Decision {
  // 1. Base rules ALWAYS apply (hard blocks, zero-access paths)
  const baseDecision = evaluateBaseRules(tool, input);
  if (baseDecision === 'block') return 'block';

  // 2. If no skill policies are installed, use current behavior
  const skillPolicies = loadSkillPolicies();
  if (!skillPolicies || skillPolicies.length === 0) {
    return evaluateLegacyPatterns(tool, input);
  }

  // 3. Check if ANY installed skill's policy allows this operation
  //    Union model: if skill A allows read of /foo and skill B
  //    allows read of /bar, both /foo and /bar are readable
  switch (tool) {
    case 'Read':
      return isPathAllowedByAnySkill(input.file_path, 'read', skillPolicies)
        ? 'allow' : 'ask';  // Not block — ask user for unmatched reads

    case 'Write':
    case 'Edit':
      return isPathAllowedByAnySkill(input.file_path, 'write', skillPolicies)
        ? 'allow' : 'ask';

    case 'Bash':
      return isCommandAllowedByAnySkill(input.command, skillPolicies)
        ? 'allow' : 'ask';

    case 'WebFetch':
      return isDomainAllowedByAnySkill(input.url, skillPolicies)
        ? 'allow' : 'ask';
  }

  return 'allow';  // Tools not covered by policies pass through
}
```

### 3.4 Install-Time Policy Generation

When `pai-pkg install skill-name` runs:

```
1. Download skill package to staging directory
2. Verify signatures (SkillSeal / Sigstore / git commit hash)
3. Read pai-manifest.yaml capabilities section
4. Display capabilities to user with risk visualization:

   ┌─────────────────────────────────────────────┐
   │  Installing: ExtractWisdom v2.1.0           │
   │  Author: danielmiessler (verified)          │
   │  Tier: Official                             │
   │                                             │
   │  Capabilities requested:                    │
   │  🟢 Read ~/.claude/skills/PAI/USER/         │
   │  🟢 Read ~/.claude/MEMORY/WORK/             │
   │  🟡 Write ~/.claude/MEMORY/WORK/            │
   │  🟡 Network: api.openai.com                 │
   │  🟡 Bash: bun Tools/ExtractWisdom.ts        │
   │  🟡 Secret: OPENAI_API_KEY                  │
   │                                             │
   │  Risk: MEDIUM (network + secret access)     │
   │                                             │
   │  [Install] [Review manifest] [Cancel]       │
   └─────────────────────────────────────────────┘

5. If user approves:
   a. Add skill section to patterns.yaml under skills:
   b. Copy skill files to ~/.claude/skills/{name}/
   c. Record in packages.db
```

### 3.5 Kill Switch

```bash
pai-pkg disable skill-name
```

This does exactly two things:
1. Removes the skill's section from `patterns.yaml`
2. Moves the skill directory from `~/.claude/skills/{name}/` to `~/.claude/skills/.disabled/{name}/`

The hook enforces immediately on the next tool call — no restart needed, because `patterns.yaml` is re-read on each invocation (already cached with file-mtime check in SecurityValidator).

To re-enable:

```bash
pai-pkg enable skill-name
```

Restores the policy section and moves files back.

---

## 4. The Composition Trust Problem

RESEARCH.md's red team identified skill composition as the weakest link:

> Skill A (trusted) calls Skill B (trusted). Skill A passes user context to Skill B via a workflow. Neither skill is malicious alone, but the composition creates an unintended capability escalation — the "confused deputy" problem.

### 4.1 How It Manifests in PAI

A SKILL.md can contain workflow routing like:

```markdown
## Workflow Routing
- For data analysis → invoke Research skill first, then invoke Parser skill
```

When the agent follows this, it's now operating with the UNION of both skills' capabilities. If Research can access the network and Parser can write files, the composition can download-and-write — a capability neither declared alone.

### 4.2 Mitigation: Capability Ceiling

The union model already handles this correctly at the enforcement boundary. The SecurityValidator doesn't care which skill "caused" a tool call — it enforces the combined policy. The risk is that installing more skills increases the total capability surface.

**Mitigation:**

1. **Capability budget warning** — `pai-pkg install` shows the TOTAL capability surface after adding the new skill, not just the new skill's capabilities. If the union creates a new risk class (e.g., first skill with both network AND write access), flag it:

```
⚠️  Warning: Installing Parser alongside Research creates a
    combined capability that neither has alone:
    - Network access (Research) + File write (Parser)
    - This combination enables download-and-write operations

    [Install anyway] [Review details] [Cancel]
```

2. **Composition audit** — `pai-pkg audit` command that scans the total installed capability surface and flags dangerous combinations.

---

## 5. Observability: Detecting Drip-Feed Attacks

The "Anthropic Attack" blog post describes an attack pattern where a malicious actor orchestrates an AI agent through a series of individually-benign tasks that compose into an attack:

> Task 1: "Read the config file" (benign)
> Task 2: "Summarize the API endpoints" (benign)
> Task 3: "Write a test that calls the staging endpoint" (benign)
> Task 4: "Run the test" (the test actually exfiltrates data via the staging endpoint)

Each operation looks legitimate in isolation. The attack is only visible when you look at the SEQUENCE holistically.

### 5.1 Current State: Event Logging Only

SecurityValidator already logs every security event to `MEMORY/SECURITY/`. But these are individual event files — there's no cross-event analysis.

### 5.2 Target State: Behavioral Anomaly Detection

A new observability layer that analyzes PATTERNS across security events within a session:

```yaml
# ~/.config/pai/security/anomaly-rules.yaml

rules:
  # Detect read-then-exfiltrate pattern
  - name: "data-staging"
    description: "Reading sensitive files followed by network access"
    trigger:
      sequence:
        - event: {tool: "Read", path_matches: "~/.config/pai/secrets/*"}
        - event: {tool: "Bash", command_matches: "curl|wget|nc|fetch|python3|node"}
      within_minutes: 5
    action: block
    severity: critical
    fail_mode: closed  # Critical = block even on evaluation error

  # Detect reconnaissance pattern
  - name: "reconnaissance-sweep"
    description: "Rapid scanning of sensitive directories"
    trigger:
      count:
        - event: {tool: "Read", path_matches: "~/.*"}
          min_count: 20
      within_minutes: 2
    action: alert
    severity: high
    fail_mode: open  # High = alert but allow on evaluation error

  # Detect privilege escalation via composition
  - name: "capability-escalation"
    description: "Network access followed by file write outside allowed paths"
    trigger:
      sequence:
        - event: {tool: "WebFetch"}
        - event: {tool: "Write", path_not_in: "allowed_write_paths"}
      within_minutes: 10
    action: ask
    severity: high
    fail_mode: open  # High = alert but allow on evaluation error
```

### 5.2.1 Fail Mode Policy

Anomaly rules have explicit fail modes, following the pai-content-filter pattern (per JC review):

| Severity | Default Fail Mode | Rationale |
|----------|------------------|-----------|
| **critical** | `closed` (block) | False positive is annoying; false negative is catastrophic (data exfiltration) |
| **high** | `open` (alert) | Alert the user, allow the operation to continue |
| **medium** | `open` (alert) | Log for trend analysis, no user interruption |

The `fail_mode` field can be explicitly set per rule to override the default. For example, a `high` severity rule that detects a known attack pattern may be set to `closed`.

### 5.3 Implementation: Dual-Hook Session Audit

**Revised per community review (JC, 2026-03-18).** The original PostToolUse-only design had a critical flaw: PostToolUse cannot block, so `read secrets → curl exfiltrate` completes before detection. The fix: split recording and enforcement across both hooks.

**Architecture:**
- **PostToolUse** (SessionAuditRecorder): Records events to rolling window. Non-blocking, append-only. ~0.3ms per call.
- **PreToolUse** (SessionAuditEnforcer): Reads rolling window, evaluates sequence/count rules BEFORE allowing the next tool call. Can block. ~5-8ms per call.

This closes the exfiltration window completely: when the agent calls `curl`, the PreToolUse enforcer sees the prior secret read in the window and blocks the curl BEFORE execution.

```typescript
// SessionAuditRecorder.hook.ts (PostToolUse)
// Records events to rolling window. Non-blocking, fast.

interface SessionEvent {
  timestamp: number;
  tool: string;
  input: Record<string, unknown>;
  result_summary: string;
}

const WINDOW_FILE = '/tmp/pai-session-audit-{session_id}.jsonl';
const MAX_WINDOW_SIZE = 100;  // ~20KB, bounded

async function main() {
  const input = JSON.parse(await Bun.stdin.text());

  const event: SessionEvent = {
    timestamp: Date.now(),
    tool: input.tool_name,
    input: sanitizeInput(input.tool_input),
    result_summary: truncate(input.tool_result, 200)
  };

  // O_APPEND for atomic writes (POSIX guarantee for reasonable sizes)
  appendToWindow(WINDOW_FILE, event, MAX_WINDOW_SIZE);
}
```

```typescript
// SessionAuditEnforcer.hook.ts (PreToolUse)
// Reads rolling window, evaluates anomaly rules. CAN BLOCK.

async function main() {
  const input = JSON.parse(await Bun.stdin.text());
  const pendingTool = { tool: input.tool_name, input: input.tool_input };

  // Read rolling window (~20KB, <1ms on warm cache)
  const events = readWindow(WINDOW_FILE);

  // Load anomaly rules
  const rules = loadAnomalyRules();

  for (const rule of rules) {
    // Check if executing this pending tool would complete a dangerous sequence
    if (wouldCompleteSequence(events, pendingTool, rule)) {
      logAnomaly(rule, pendingTool);

      if (rule.severity === 'critical') {
        // FAIL-CLOSED: block the tool call
        process.exit(2);  // PreToolUse exit 2 = block
      } else if (rule.action === 'ask') {
        // FAIL-OPEN with user prompt
        console.error(`[PAI SECURITY] ⚠️ ${rule.description}`);
        process.exit(1);  // exit 1 = ask user
      } else {
        // ALERT: log but allow
        console.error(`[PAI SECURITY] ⚠️ Anomaly: ${rule.description}`);
      }
    }
  }

  // No anomaly matched — allow
  process.exit(0);
}
```

### 5.4 Observability Dashboard (Future)

Integration with Arbor's observability patterns — specifically the dual-emit model (durable event log + real-time signal bus). In PAI's context:

- **Durable**: Security events in `MEMORY/SECURITY/` (already exists)
- **Real-time**: SSE stream from ivy-blackboard (ivy's shipped infrastructure)
- **Dashboard**: ivy-blackboard's web UI at localhost:3141 (already shipped, needs security event integration)

### 5.5 Maturity Levels

| Level | What | When |
|-------|------|------|
| **L1: Event logging** | Individual security events to MEMORY/SECURITY/ | **Today (shipped)** |
| **L2: Skill-scoped policies** | patterns.yaml skill sections, install/disable | **Phase 1 of pai-pkg** |
| **L3: Behavioral anomaly detection** | Dual-hook session audit (PreToolUse blocks, PostToolUse records) | **Phase 2** |
| **L4: Cross-session correlation** | Persistent event store with trend analysis | **Phase 3** |
| **L5: Real-time dashboard** | Integration with ivy-blackboard for live monitoring | **Phase 4** |

---

## 6. Integration Architecture

### 6.1 How All Components Compose

```
┌──────────────────────────────────────────────────────────────────┐
│                     PAI Installation (~/.claude/)                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ENFORCEMENT BOUNDARY (PreToolUse hooks)                    │ │
│  │                                                             │ │
│  │  SecurityValidator.hook.ts ←── patterns.yaml                │ │
│  │   • Base security rules     │   • Base rules (always)      │ │
│  │   • Skill-scoped policies   │   • Skill policies (additive)│ │
│  │   • <10ms per call          │   • Managed by pai-pkg CLI   │ │
│  │                             │                               │ │
│  │  ContentFilter hooks ←── pai-content-filter patterns        │ │
│  │   • Inbound prompt injection detection (34 patterns)        │ │
│  │   • Quarantine for external content                         │ │
│  │                                                             │ │
│  │  SkillGuard.hook.ts                                         │ │
│  │   • Blocks false-positive skill invocations                 │ │
│  │                                                             │ │
│  │  SkillEnforcer hooks ←── skill-enforcer patterns            │ │
│  │   • Validates skill structure on invocation                 │ │
│  │   • Ensures EXTEND.yaml customizations load                 │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  OUTBOUND PROTECTION                                        │ │
│  │                                                             │ │
│  │  Pre-commit hook ←── pai-secret-scanning rules              │ │
│  │   • 8 custom gitleaks rules (Anthropic, OpenAI, etc.)       │ │
│  │   • Blocks commits with embedded secrets                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  SKILL LIFECYCLE (pai-pkg CLI)                              │ │
│  │                                                             │ │
│  │  install ──→ verify signature ──→ display capabilities      │ │
│  │          ──→ user approves ──→ merge into patterns.yaml     │ │
│  │          ──→ place files ──→ record in packages.db          │ │
│  │                                                             │ │
│  │  disable ──→ remove from patterns.yaml                      │ │
│  │          ──→ move to .disabled/                              │ │
│  │                                                             │ │
│  │  audit ──→ scan total capability surface                    │ │
│  │        ──→ flag dangerous combinations                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  BEHAVIORAL ENFORCEMENT (PreToolUse — Session Audit)        │ │
│  │                                                             │ │
│  │  SessionAuditEnforcer.hook.ts (PreToolUse, priority 8)      │ │
│  │   • Reads rolling event window before each tool call        │ │
│  │   • Evaluates sequence rules (drip-feed detection)          │ │
│  │   • Critical severity → BLOCK (exit 2)                      │ │
│  │   • High/medium severity → ALERT (log, allow)               │ │
│  │   • <8ms p99 (bounded window read + pattern match)          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  OBSERVABILITY (PostToolUse — Event Recording)              │ │
│  │                                                             │ │
│  │  SessionAuditRecorder.hook.ts (PostToolUse)                 │ │
│  │   • Appends events to rolling window (~0.3ms, O_APPEND)     │ │
│  │   • Bounded to last 100 events (~20KB)                      │ │
│  │   • Session-scoped tmpfile: /tmp/pai-session-audit-{id}     │ │
│  │                                                             │ │
│  │  Security event log → MEMORY/SECURITY/ (already shipping)   │ │
│  │  Future: → ivy-blackboard SSE stream → dashboard            │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 How Spoke Repos Become Active

The pai-collab spoke repos (pai-secret-scanning, pai-content-filter, skill-enforcer) are currently maintained by @jcfischer as independent GitHub repos. They're registered on the pai-collab blackboard but not bundled into PAI installations. Here's how they integrate:

**Current state:** Each spoke repo has its own installation mechanism (shell scripts, manual hook registration). They work individually but aren't composed.

**Target state:** `pai-pkg` serves as the composition layer:

```bash
# pai-pkg integrates the security stack as "infrastructure skills"
# These aren't regular skills — they're enforcement components

pai-pkg install --system pai-secret-scanning
# → Installs gitleaks rules to ~/.config/pai/security/
# → Registers pre-commit hook

pai-pkg install --system pai-content-filter
# → Installs prompt injection patterns
# → Registers content-filter hooks (PreToolUse on Read/Glob/Grep)

pai-pkg install --system skill-enforcer
# → Installs skill structure validation
# → Registers PreToolUse hooks for Skill tool
```

The `--system` flag distinguishes infrastructure packages from regular skills. System packages:
- Cannot be disabled by non-maintainer users (requires `--system` flag + separate confirmation)
- Are verified against a separate trust chain (the hive's allowed-signers)
- Update independently from regular skills via signed atomic operations (write tmp, validate, rename)
- Provide patterns/rules consumed by the SecurityValidator rather than SKILL.md instructions
- Install to a protected path (`~/.config/pai/system-skills/`) separate from user skills
- Have integrity verified at SessionStart + periodically (every 30 minutes for long sessions)

### 6.2.1 System Package Manifest Schema

System packages use the same `pai-manifest.yaml` format as regular skills (manifest superset model, per council review), with an additional `system` section:

```yaml
name: pai-content-filter
version: 3.2.0
type: system                      # Distinguishes from type: skill

author:
  name: jcfischer
  github: jcfischer

# System-specific section (not present in regular skills)
system:
  hooks:
    pre_tool_use:
      - file: hooks/ContentFilter.hook.ts
        priority: 10              # 0-9 reserved for core, 10-29 for system, 50+ for user
        tools: [Read, Glob, Grep]
    pre_commit:
      - file: hooks/secret-scan.sh
  patterns:
    - file: patterns/content-filter.yaml
      merge_into: base            # Merge into base rules, not skills section
  protected: true                 # Cannot be disabled without --system flag
  update_policy: manual           # auto | manual — manual requires explicit confirmation

capabilities:
  filesystem:
    read: ["~/.claude/skills/"]   # Reads skill content for filtering
  network: []
  bash:
    allowed: false
  secrets: []
```

**Priority ranges (council consensus):**

| Range | Reserved For | Examples |
|-------|-------------|---------|
| 0-9 | Core PAI hooks | SecurityValidator (5) |
| 10-29 | System packages | ContentFilter (10), SkillEnforcer (15), SecretScanning (20) |
| 30-49 | Reserved (future) | — |
| 50-99 | User hooks | Custom PreToolUse hooks |

**Collaboration note:** This schema is a starting point proposed by @jcfischer. The first `--system` package (pai-content-filter) will be co-designed with JC to validate the schema against real integration needs.

**How to activate them today (before pai-pkg exists):**

1. Clone the spoke repos locally
2. Run their install scripts
3. Register their hooks in `settings.json`

This is the current manual process. `pai-pkg install --system` automates it.

### 6.3 Relationship to the-hive Protocol

The Hive's 7 protocol specs include a **Skill Protocol** that defines how skills are packaged, shared, and installed across a hive of operators. pai-pkg implements this protocol for the PAI context:

| Hive Protocol Concept | pai-pkg Implementation |
|----------------------|----------------------|
| Spoke manifest (`.collab/manifest.yaml`) | `pai-manifest.yaml` (capability declarations) |
| Spoke status (`.collab/status.yaml`) | `packages.db` (installed package state) |
| Operator identity (Ed25519 signing key) | SkillSeal / Sigstore author signature |
| Hub trust (allowed-signers) | `sources.yaml` tier policies |
| Four compliance layers | Install-time verification pipeline |
| Kill switch | `pai-pkg disable` (policy removal) |

---

## 7. Current State vs Target State

| Layer | Current State | Target State | Gap |
|-------|--------------|-------------|-----|
| **Tool-call interception** | SecurityValidator.hook.ts intercepts Bash/Read/Write/Edit | Same hook, extended with skill-scoped policies | Schema extension only |
| **Policy engine** | patterns.yaml with global rules | patterns.yaml v2.0 with base + skill sections | YAML schema migration |
| **Install-time policy** | N/A (skills installed manually) | `pai-pkg install` reads manifest, merges policy | New CLI command |
| **Kill switch** | N/A | `pai-pkg disable` removes policy section | New CLI command |
| **Inbound protection** | pai-content-filter (shipped, standalone) | Integrated as `--system` package | Packaging wrapper |
| **Outbound protection** | pai-secret-scanning (shipped, standalone) | Integrated as `--system` package | Packaging wrapper |
| **Skill validation** | skill-enforcer (shipped, standalone) | Integrated as `--system` package | Packaging wrapper |
| **Capability declarations** | pai-manifest.yaml (designed, not enforced) | Manifest → policy at install time | Policy generation code |
| **Composition awareness** | None | Capability budget warnings at install | New audit logic |
| **Session observability** | Individual event files in MEMORY/SECURITY/ | Dual-hook: PreToolUse enforcer + PostToolUse recorder | New hook pair |
| **Cross-session analysis** | None | Persistent event store + trend rules | Future (L4) |
| **Real-time dashboard** | None | ivy-blackboard integration | Future (L5) |

---

## 8. Implementation Phases

### Phase 1: Extend the Firewall (Weeks 1-4)

**Goal:** SecurityValidator enforces skill-scoped policies.

1. **patterns.yaml v2.0 schema** — Add `skills:` section alongside existing rules
2. **Policy merge logic** — SecurityValidator loads both base and skill sections
3. **`pai-pkg install` policy generation** — Read `pai-manifest.yaml`, create skill policy section, merge into `patterns.yaml`
4. **`pai-pkg disable/enable`** — Remove/restore skill policy sections
5. **Capability display** — Risk-tiered visual output during install (green/amber/red)

**Deliverables:**
- Extended `SecurityValidator.hook.ts` (backward compatible — if no `skills:` section, behavior unchanged)
- `pai-pkg` CLI with `install`, `disable`, `enable`, `list` commands
- `patterns.yaml` v2.0 schema documented

### Phase 2: Observability + Composition (Weeks 5-8)

**Goal:** Detect behavioral anomalies and flag dangerous capability combinations.

1. **Dual-hook Session Audit** — SessionAuditRecorder (PostToolUse, records events) + SessionAuditEnforcer (PreToolUse, blocks dangerous sequences)
2. **anomaly-rules.yaml** — Sequence and count-based pattern detection with fail mode policy (critical=closed, high/medium=open)
3. **`pai-pkg audit`** — Scan total installed capability surface for dangerous unions (including secrets+network composition)
4. **Composition warnings** — Flag when installing a skill creates new combined capabilities
5. **Integration of spoke repos** — Package pai-secret-scanning, pai-content-filter, skill-enforcer as `--system` packages using system manifest schema
6. **Publish-time SKILL.md static analysis** — Registry-side scan for tool references inconsistent with declared capabilities
7. **Arbor-style rate limiting** — Constraint enforcement (rate limits, time windows) for reconnaissance detection

**Deliverables:**
- Dual-hook SessionAudit shipping with default anomaly rules
- `pai-pkg audit` command (already built, needs composition expansion)
- Three `--system` packages created (co-designed with @jcfischer)

### Phase 3: Cross-Session Intelligence (Weeks 9-16)

**Goal:** Persistent behavioral analysis across sessions.

1. **Event store** — SQLite database for security events (building on ivy-blackboard's pattern)
2. **Cross-session anomaly detection** — Persistent state that survives session boundaries. An attacker exfiltrating one file per session over 10 sessions triggers cross-session thresholds.
3. **Runtime telemetry (opt-in)** — Log which capabilities are actually exercised during skill invocations, so `pai-pkg audit` can distinguish "theoretical risk" from "observed risk." This reduces audit noise for capability combinations that exist in theory but never co-occur in practice.
4. **ivy-blackboard integration** — Security events streamed via SSE to dashboard
5. **Incident response** — Automated policy tightening on anomaly detection

**Deliverables:**
- Security event SQLite store
- ivy-blackboard security panel
- Cross-session anomaly rules
- Runtime capability telemetry (opt-in)

---

## 9. Concrete Code Examples

### 9.1 Extended SecurityValidator (Phase 1)

The key change to SecurityValidator.hook.ts — adding skill policy evaluation:

```typescript
// New: Load skill policies from patterns.yaml v2.0
interface SkillPolicy {
  installed: string;
  manifest_hash: string;
  capabilities: {
    filesystem?: {
      read?: string[];
      write?: string[];
    };
    network?: {
      allowed_domains?: string[];
    };
    bash?: {
      allowed_patterns?: string[];
    };
    secrets?: string[];
  };
}

function getSkillPolicies(): Record<string, SkillPolicy> {
  const patterns = loadPatterns();
  return (patterns as any).skills || {};
}

function isPathAllowedBySkills(
  filePath: string,
  action: 'read' | 'write',
  policies: Record<string, SkillPolicy>
): boolean {
  for (const [, policy] of Object.entries(policies)) {
    const paths = action === 'read'
      ? policy.capabilities.filesystem?.read || []
      : policy.capabilities.filesystem?.write || [];

    for (const allowed of paths) {
      if (matchesPathPattern(filePath, allowed)) {
        return true;
      }
    }
  }
  return false;
}

function isBashAllowedBySkills(
  command: string,
  policies: Record<string, SkillPolicy>
): boolean {
  for (const [, policy] of Object.entries(policies)) {
    const patterns = policy.capabilities.bash?.allowed_patterns || [];
    for (const pattern of patterns) {
      if (matchesPattern(command, pattern)) {
        return true;
      }
    }
  }
  return false;
}
```

### 9.2 Policy Generation from Manifest (Phase 1)

```typescript
// pai-pkg install: manifest → policy conversion

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFileSync, writeFileSync } from 'fs';

interface PaiManifest {
  name: string;
  version: string;
  capabilities: {
    filesystem?: { read?: string[]; write?: string[] };
    network?: Array<{ domain: string; reason: string }>;
    bash?: { allowed: boolean; restricted_to?: string[] };
    secrets?: string[];
  };
}

function generateSkillPolicy(manifest: PaiManifest, manifestHash: string): SkillPolicy {
  return {
    installed: new Date().toISOString().split('T')[0],
    manifest_hash: manifestHash,
    capabilities: {
      filesystem: {
        read: manifest.capabilities.filesystem?.read || [],
        write: manifest.capabilities.filesystem?.write || [],
      },
      network: {
        allowed_domains: (manifest.capabilities.network || []).map(n => n.domain),
      },
      bash: {
        allowed_patterns: manifest.capabilities.bash?.restricted_to || [],
      },
      secrets: manifest.capabilities.secrets || [],
    },
  };
}

function mergeSkillIntoPatterns(skillName: string, policy: SkillPolicy): void {
  const patternsPath = getUserPatternsPath();
  const patterns = parseYaml(readFileSync(patternsPath, 'utf-8'));

  if (!patterns.skills) patterns.skills = {};
  patterns.skills[skillName] = policy;

  writeFileSync(patternsPath, stringifyYaml(patterns));
}

function removeSkillFromPatterns(skillName: string): void {
  const patternsPath = getUserPatternsPath();
  const patterns = parseYaml(readFileSync(patternsPath, 'utf-8'));

  if (patterns.skills?.[skillName]) {
    delete patterns.skills[skillName];
    writeFileSync(patternsPath, stringifyYaml(patterns));
  }
}
```

### 9.3 Anomaly Rule Evaluation (Phase 2)

```typescript
// SessionAudit.hook.ts: behavioral pattern detection

interface AnomalyRule {
  name: string;
  description: string;
  trigger: SequenceTrigger | CountTrigger;
  action: 'block' | 'alert' | 'ask';
  severity: 'critical' | 'high' | 'medium';
}

interface SequenceTrigger {
  sequence: Array<{
    event: { tool: string; path_matches?: string; command_matches?: string };
  }>;
  within_minutes: number;
}

function evaluateSequenceRule(
  events: SessionEvent[],
  rule: AnomalyRule & { trigger: SequenceTrigger }
): boolean {
  const windowMs = rule.trigger.within_minutes * 60 * 1000;
  const now = Date.now();
  const recentEvents = events.filter(e => now - e.timestamp < windowMs);

  // Check if all sequence steps appear in order
  let stepIndex = 0;
  for (const event of recentEvents) {
    const step = rule.trigger.sequence[stepIndex];
    if (matchesEventCriteria(event, step.event)) {
      stepIndex++;
      if (stepIndex === rule.trigger.sequence.length) {
        return true;  // Full sequence matched
      }
    }
  }
  return false;
}
```

---

## 10. What This Does NOT Cover

This document focuses on **runtime enforcement and observability**. The following are covered by companion documents:

- **Transport layer** (how packages are fetched) → [DESIGN.md](DESIGN.md) Section 7
- **Cryptographic signing** (how packages are verified) → [DESIGN.md](DESIGN.md) Section 3
- **Governance tiers** (Official/Community/Universe) → [DESIGN.md](DESIGN.md) Section 1
- **Threat model** (comprehensive threat analysis) → [RESEARCH.md](RESEARCH.md) Section 4
- **Standards alignment** (AAIF, MCP, Agent Skills) → [RESEARCH.md](RESEARCH.md) Section 8
- **The sandbox question** (why not VM/sandbox) → [RESEARCH.md](RESEARCH.md) Section 9

---

## 11. Design Principles

These principles are derived from Arbor's security philosophy and validated through the first-principles analysis:

1. **Extend, don't replace.** SecurityValidator.hook.ts is the firewall. Extend its policy schema, don't build a new system.

2. **Deterministic evaluation only.** No LLM reasoning in the security path. YAML pattern matching in <10ms. Deterministic outcomes for identical inputs.

3. **Install = policy change.** A skill's capabilities become enforceable the moment `pai-pkg install` merges them into patterns.yaml. No runtime skill attribution needed.

4. **Base rules are inviolable.** Skill policies are additive — they can only ADD capabilities within the allowed space. They cannot override base security rules (zeroAccess paths, blocked commands).

5. **Fail-safe for enforcement, fail-open for convenience.** Unknown tool calls that could cause harm → block or ask. Unknown tool calls that are read-only → allow. Never silently allow a write/execute operation that no policy covers.

6. **Observe everything, analyze holistically.** Individual events are logged (L1, today). Behavioral patterns across events detect drip-feed attacks (L3, Phase 2). Cross-session trends detect persistent adversaries (L4, Phase 3).

7. **The kill switch must work instantly.** `pai-pkg disable` removes the policy section from patterns.yaml. The very next tool call is evaluated without that skill's capabilities. No restart, no delay.

8. **The security policy must be self-protecting.** `patterns.yaml`, `SecurityValidator.hook.ts`, and `settings.json` are in the `readOnly` paths of the base security rules. Modifications require explicit user confirmation. The hook verifies its own configuration integrity (manifest hash check) on every load.

9. **Signing proves WHO, not WHETHER SAFE.** SkillSeal creates accountability, not safety guarantees. Users should not reduce scrutiny because a skill is "verified" — verification means identity, not intent. Capability review remains essential regardless of trust tier.

10. **Blocklists are incomplete by nature.** Bash is Turing-complete; there are infinite ways to express the same operation. Pattern matching against command strings is necessary but not sufficient. Defense in depth (behavioral detection, capability composition analysis, runtime telemetry) compensates for blocklist incompleteness. This is a documented known limitation.

---

## References

- **Arbor Security Design** — `~/Developer/arbor/docs/arbor-security-design.md` (50.4KB, 5-layer authorization pipeline)
- **SecurityValidator** — `~/.claude/hooks/SecurityValidator.hook.ts` (PAI's existing tool-call firewall)
- **pai-collab Trust Model** — `~/Developer/pai-collab/TRUST-MODEL.md` (threat vectors and defense layers)
- **Steffen025 Security Reviews** — `~/Developer/pai-collab/reviews/` (4 adversarial reviews)
- **AvaKill** — `github.com/log-bell/avakill` (YAML-based tool-call interception reference)
- **"Gas Town Needs a Citadel"** — Sondera AI blog (agent control architecture)
- **"The Anthropic Attack"** — Sondera AI blog (trust stack framework, drip-feed attack pattern)
- **RESEARCH.md** — This repo (comprehensive landscape analysis and red team findings)
- **DESIGN.md** — This repo (transport, trust, governance layers)

---

## License

MIT
