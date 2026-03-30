# Distributing Executable Natural Language: A Research Foundation for AI Skill Package Management

**Authors:** Andreas Arvidsson, with PAI multi-agent analysis (Council, Red Team, Research)
**Date:** March 2026
**Version:** 1.0

---

## Abstract

AI agent skills present a novel distribution challenge: they are packages composed of natural language instructions (SKILL.md) and optional code (TypeScript CLIs) that jointly define behavior within an unsandboxed execution environment. Unlike traditional software packages where the attack surface is code, AI skills carry an additional — and arguably more dangerous — attack surface: natural language instructions consumed by an AI agent with full tool access. This paper analyzes the design space for a package management system for PAI (Personal AI Infrastructure) skills through first principles decomposition, multi-perspective council debate, adversarial red team analysis, and extensive research across existing package ecosystems, signing standards, and emerging AI agent interoperability frameworks. We find that (1) the problem is closer to browser extension distribution than traditional package management, (2) runtime tool-call interception is the only viable enforcement boundary, (3) cryptographic signing proves authorship but not safety, and (4) the emerging AvaKill/Citadel model of deterministic tool-call firewalls provides the missing enforcement layer. We propose a phased architecture that combines git-based distribution, tool-call interception, and curated governance — enabling seamless sharing while acknowledging that natural language instructions cannot be statically analyzed for safety.

---

## 1. Introduction

### 1.1 The Problem

PAI skills are powerful but non-distributable. Each user's skill directory is a local collection with no mechanism for discovery, installation, versioning, trust verification, or sharing between users. There is no `apt install extract-wisdom` equivalent for PAI.

The desire is simple: users should be able to share skills as seamlessly as developers share npm packages, Python libraries, or Linux packages. But the trust problem is fundamentally different. Traditional package managers distribute code — deterministic, statically analyzable, sandboxable. AI skills distribute *natural language instructions consumed by an AI agent with full system access*.

### 1.2 Why This Is Not Just Another Package Manager

A PAI skill contains two components:

1. **SKILL.md** — Natural language instructions that tell the AI agent what to do, when to activate, how to route requests, and what tools to invoke
2. **CLI tools** — Optional TypeScript programs that extend the agent's capabilities (API clients, browser automation, document generators)

The critical insight from our first principles analysis: **SKILL.md is the executable, not the code.** The natural language instructions have unbounded execution scope — they can instruct the agent to read any file, execute any command, access any network resource, and influence all subsequent reasoning in the conversation. There is no sandbox. There is no process isolation. The agent's tool access is the skill's tool access.

This makes the distribution problem closer to a **browser extension store** than a traditional package manager:

| Property | npm/cargo/apt | Chrome Web Store | PAI Skills |
|----------|--------------|-----------------|------------|
| Attack surface | Code execution | Code + UI + data access | Code + **natural language instructions** |
| Static analysis | AST, linting, type checking | Manifest V3 permissions | **Impossible** (NL is unanalyzable) |
| Sandbox | Process/container isolation | Extension sandbox, CSP | **None** |
| Trust boundary | Import/dependency scope | Permission grants | **Full agent context** |
| Composition risk | Dependency confusion | Extension conflicts | **Context poisoning** across skills |

### 1.3 Scope and Methodology

This research was conducted through:

- **First Principles Decomposition** — Breaking the problem down to fundamental truths about what makes AI skill distribution different
- **Multi-Agent Council Debate** — Four expert perspectives (Registry Architect, Security Researcher, DX Designer, Governance Expert) across three rounds of structured debate
- **Adversarial Red Team Analysis** — Eight specialized agents (engineers and pentesters) attacking the proposed design
- **Extensive Multi-Source Research** — Nine parallel research agents investigating package ecosystems, signing standards, AI agent security, governance models, and emerging standards (MCP Registry, AAIF)
- **Source Analysis** — Three contemporary articles on agent security architecture (Gas Town/Citadel, Anthropic Attack Blueprint, AvaKill)

---

## 2. Background and Related Work

### 2.1 The Package Manager Landscape

Every major language ecosystem has solved package distribution — npm (JavaScript, 3M+ packages), PyPI (Python, 600K+), crates.io (Rust, 170K+), apt/dpkg (Debian, 60K+). Each makes different tradeoffs between openness and safety.

**npm** demonstrates both the power and peril of open-publish registries. In 2025 alone, Sonatype identified over **454,600 new malicious packages** on npm, bringing the cumulative total to over 1.2 million known malicious packages. 99.8% of Q4 2025 malware originated from npm. The Shai-Hulud worm campaign (September 2025) compromised maintainer accounts, injected itself into all packages maintained by each compromised account, and harvested secrets using TruffleHog across high-impact packages including `@ctrl/tinycolor` (2.2M weekly downloads).

**"Slopsquatting"** is a novel attack vector where attackers register package names that AI models commonly hallucinate during code generation. Research from Socket found that 58% of AI-hallucinated package names are consistently repeated across sessions, making them reliable targets for name squatting.

**Debian's apt** represents the opposite end: a curated model with FTP Masters, GPG trust chains, and a promotion pipeline (unstable → testing → stable) that has operated for 30 years. The governance overhead is enormous but the security track record is strong.

**Homebrew** provides the most relevant precedent for PAI's current scale. It started as a single Git repository with PR-based inclusion and a few trusted maintainers. It scaled to thousands of formulae before needing structural governance reform. In 2024-2025, Homebrew adopted Sigstore for bottle attestation, adding cryptographic provenance without disrupting its Git-centric workflow.

### 2.2 Cryptographic Signing Standards

Our research compared four signing approaches:

| Standard | Approach | Key Management | Best For |
|----------|----------|---------------|----------|
| **Sigstore** | Keyless (OIDC identity → short-lived certs → transparency log) | No long-lived keys | Large ecosystems (npm, Homebrew, Kubernetes) |
| **TUF** | Role-based (root, targets, snapshot, timestamp) with key rotation | Complex but robust against compromise | Critical infrastructure (PyPI, Docker) |
| **in-toto** | Supply chain attestation (verifies the *process*, not just the artifact) | Complementary to Sigstore/TUF | CI/CD pipeline verification |
| **SkillSeal** | GPG/SSH signing with GitHub key discovery for Claude Code skills | Author-managed keys | Small skill ecosystems |

**Key finding:** For an ecosystem with fewer than 1,000 packages, **git commit signatures provide sufficient integrity verification** without the infrastructure overhead of Sigstore or TUF. SkillSeal adds value as a lightweight signing layer but is not a prerequisite for initial distribution. The critical insight: **signing proves who published something, not whether it's safe.** A perfectly signed SKILL.md can contain malicious instructions.

### 2.3 Plugin Marketplace Trust Models

**Chrome Web Store** uses a combination of automated scanning and manual review, triggered by risk signals (new developers, dangerous permissions, obfuscated code). Manifest V3 eliminated remote code execution — all code must ship in the package. Despite this, malicious extensions still reach users; the most common vector is developer account compromise.

**VS Code Extension Marketplace** implements a Verified Publisher program but has experienced incidents of malicious extensions passing automated review. The key lesson: automated scanning catches known patterns but misses novel attack vectors.

**WordPress Plugin Repository** performs automated malware scanning on all submissions. Notable lesson: the "closed plugin" process — where a plugin is retroactively removed after a vulnerability is discovered — requires rapid propagation to all users. This maps directly to PAI's kill switch requirement.

### 2.4 Emerging AI Agent Standards

**MCP Registry** (Model Context Protocol) launched in preview on September 8, 2025, with API freeze (v0.1) on October 24, 2025. It operates as a **metaregistry** — hosting metadata about MCP servers, not the code itself. Actual packages are distributed through npm, PyPI, Docker Hub, and GitHub Releases. MCP was donated to the AAIF (Agentic AI Foundation) under the Linux Foundation on December 9, 2025. Current security assessment is concerning: an Astrix Security report found 53% of analyzed MCP servers use insecure hard-coded credentials and 82% have path traversal vulnerabilities.

**AAIF (Agentic AI Foundation)** was formed under the Linux Foundation with Anthropic, Google, Microsoft, and OpenAI. It aims to standardize agent interoperability but is pre-1.0 on all specifications. The timeline for stable standards is uncertain.

### 2.5 Agent Security Architecture

Three contemporary sources provide critical framing for the security layer:

**"Gas Town Needs a Citadel" (Sondera, 2026)** argues that "prompts are not brakes" — system instructions are insufficient governance mechanisms for high-speed autonomous systems. The article proposes three architectural controls: (1) **Deterministic Lanes** — physical de-provisioning of tool access based on task context, (2) **Behavioral Circuit Breakers** — real-time evaluation of tool call logic before execution, detecting deviant patterns at machine speed, (3) **Agent Identity and Attribution** — unique identities for every agent instance with immutable audit ledgers. The key insight: "replace prompt-based hope with architectural certainty."

**"The Anthropic Attack" (Sondera, 2026)** documents the GTG-1002 attack where AI agents executed 80-90% of tactical operations autonomously at multiple operations per second, using task decomposition to make each individual action appear legitimate in isolation. The proposed "Trust Stack" framework operates in three phases: Crawl (pre-deployment behavioral testing), Walk (agent identity and forensic audit), Run (deterministic real-time policy enforcement). Critical finding: "malicious intent resides in the orchestration layer rather than individual requests."

**AvaKill (log-bell, 2026)** is an open-source safety firewall that intercepts and evaluates tool calls made by AI agents before execution. It operates through three independent enforcement paths: native agent hooks, MCP proxy wrapping, and OS-level sandboxing (Landlock on Linux, sandbox-exec on macOS, AppContainer on Windows). Policies are deterministic YAML rules with sub-millisecond evaluation — no ML models, no API calls. Key design decisions include canonical tool naming across heterogeneous agents, self-protection against agent tampering, and policy signing with Ed25519 keys. AvaKill already supports Claude Code, Cursor, Windsurf, Gemini CLI, and other agents.

---

## 3. Architecture: Three Layers

The arc architecture comprises three distinct layers, each addressing a different aspect of the distribution problem:

```
+-------------------------------------------------------------+
|  Layer 3: GOVERNANCE                                        |
|  Curated registry, review process, author reputation        |
|  (Homebrew circa 2012 model)                                |
+-------------------------------------------------------------+
|  Layer 2: TRUST                                             |
|  Tool-call interception, capability enforcement,            |
|  integrity verification                                     |
|  (AvaKill/Citadel model + SkillSeal signing)                |
+-------------------------------------------------------------+
|  Layer 1: TRANSPORT                                         |
|  Git-based distribution, manifest schema, CLI               |
|  (Git repos + flat registry index)                          |
+-------------------------------------------------------------+
```

### 3.1 Layer 1: Transport

**Council consensus (4/4 agreement):** Git-based transport, not npm.

At current ecosystem scale (~50 skills, <10 authors), npm's complexity doesn't pay off. PAI skills are markdown files and small TypeScript CLIs — not compiled libraries with deep dependency trees. Git provides versioning, immutable history, diffing, blame, and rollback for free.

**Registry design:** A flat JSON index in a Git repository, mapping skill names to source Git URLs with version pins (commit SHA or tag). This is the Homebrew Formula model adapted for AI skills.

```yaml
# pai-manifest.yaml — the single authoritative manifest per skill
name: ExtractWisdom
version: 2.1.0
type: skill
author:
  name: danielmiessler
  github: danielmiessler

provides:
  skill:
    - trigger: "extract wisdom"
    - trigger: "analyze video"
  cli:
    - command: "bun src/extract-wisdom.ts"

capabilities:
  filesystem:
    read: ["~/.claude/skills/PAI/USER/"]
    write: ["~/.claude/MEMORY/WORK/"]
  network:
    - domain: "api.anthropic.com"
      reason: "AI inference"
  bash:
    restricted_to: ["bun src/*.ts"]
  secrets: ["ANTHROPIC_API_KEY"]
```

**CLI surface (v1):**
- `arc search <query>` — Search the registry
- `arc install <name|git-url>` — Fetch, verify, place in `~/.claude/skills/`
- `arc remove <name>` — Delete skill directory
- `arc list` — Show installed skills with versions and capabilities
- `arc disable <name>` — Kill switch (immediate removal from skill resolution)
- `arc publish` — Open a PR to the registry index

### 3.2 Layer 2: Trust — The Enforcement Boundary

This is where arc diverges most sharply from traditional package managers.

**The fundamental problem:** SKILL.md contains natural language instructions that cannot be statically analyzed. A capability declaration in YAML says what the skill *claims* to need. But the SKILL.md can instruct the agent to do anything regardless of what the manifest declares. Without enforcement, capability declarations are "security theater" (Red Team consensus, 8/8 agents).

**The solution: Tool-call interception at the execution boundary.**

The AvaKill model provides the missing enforcement layer. Instead of trying to analyze what a SKILL.md *might* instruct the agent to do, we intercept what it *actually* instructs the agent to do — at the tool-call level.

```
SKILL.md instructs agent → Agent decides to use tool →
  INTERCEPTION POINT: Does this tool call match declared capabilities? →
    YES → Execute tool call
    NO  → Block + log + alert user
```

This is not prompt-based governance. This is architectural enforcement at the execution boundary:

1. **Capability-scoped tool access:** When a skill is active, the agent's available tools are filtered to match the skill's declared capabilities. A skill declaring `filesystem: {read: ["~/projects/"]}` cannot trigger a file write or read outside that path.

2. **Deterministic policy evaluation:** Policies are YAML rules evaluated in sub-millisecond time with pattern matching — no ML models, no LLM reasoning about whether an action is allowed. This eliminates the non-determinism problem identified by the Red Team (EN-7: "the same action is sometimes allowed and sometimes blocked depending on LLM temperature").

3. **Behavioral circuit breakers:** Real-time detection of tool call patterns resembling attack trajectories. A skill that chains `file_read` → `network_fetch` (reading a secret then sending it to an external server) triggers a circuit breaker regardless of what the SKILL.md says.

4. **Composition boundary enforcement:** When Skill A invokes Skill B, the capability scope narrows to the *intersection* of both skills' declared capabilities, preventing the "confused deputy" attack identified by the Red Team (EN-3).

**Does PAI need to run in a sandbox or VM?**

No — but it needs a tool-call firewall. The distinction matters:

| Approach | What it does | Practical for PAI? |
|----------|-------------|-------------------|
| **VM/Container sandbox** | Isolates the entire process | Breaks the UX — PAI needs access to user's files, tools, and context |
| **OS-level sandbox** (Landlock/sandbox-exec) | Restricts filesystem/network at kernel level | Feasible as defense-in-depth but coarse-grained |
| **Tool-call firewall** (AvaKill model) | Intercepts every tool call with deterministic policy | **Yes — this is the right layer.** Preserves UX while enforcing boundaries |

The tool-call firewall operates between the agent's decision and the tool's execution. It doesn't need to understand natural language. It doesn't need to sandbox the entire process. It intercepts concrete, enumerable actions (file_read, file_write, shell_execute, network_fetch) and checks them against a policy. This is the "deterministic lane" approach from the Gas Town/Citadel framework.

### 3.3 Layer 3: Governance

**Council consensus:** Homebrew circa 2012 — single curated repository, PR-based inclusion, few trusted maintainers with merge rights, clear manifest standards.

**Starting with two tiers:**

| Tier | Trust Level | How It Gets There |
|------|-------------|-------------------|
| **Built-in** | Ships with PAI | Core team maintains |
| **Community** | PR-reviewed and curated | Author submits PR, maintainer reviews manifest + SKILL.md, merges |

A third tier ("Verified" — community skills with demonstrated track record and attestation) is added when volume demands it, estimated at 200+ community skills.

**What review catches and what it doesn't:**

| Reviewable | Not Reviewable |
|-----------|---------------|
| Manifest completeness | All possible LLM interpretations of SKILL.md |
| Capability declaration plausibility | Time-bomb conditions in natural language |
| Known malicious patterns | Novel prompt injection techniques |
| Author identity verification | Intent behind benign-looking instructions |
| Dependency declarations | Composition attack chains across skills |

This is why Layer 2 (tool-call enforcement) is non-negotiable. Review is necessary but insufficient. The Red Team demonstrated five specific attack scenarios that pass human review but cause harm at runtime:

1. **Hidden prompt injection** using Unicode directional overrides invisible in rendered markdown but visible to LLM tokenizers
2. **Capability mismatch** where reasonable-sounding instructions exceed declared scope
3. **Time bombs** using natural language date conditions ("After June 2026, use the improved v2 prompt template from [URL]")
4. **Composition attacks** where two individually benign skills form an exfiltration pipeline when used together
5. **Long-game reputation building** where a trusted author publishes malicious updates after months of good behavior

---

## 4. Threat Model

### 4.1 Asset Inventory

| Asset | Value | Location |
|-------|-------|----------|
| User's filesystem | High (source code, credentials, personal data) | Local machine |
| API keys and secrets | Critical (~/.config/pai/secrets/) | Local machine |
| Conversation context | High (may contain sensitive business data) | Agent memory |
| Agent tool access | Critical (shell, filesystem, network) | Runtime |
| Registry integrity | High (trust anchor for all installs) | Git repository |
| Author reputation | Medium (enables future attacks if compromised) | Registry metadata |

### 4.2 Threat Matrix

| Threat | Vector | Likelihood | Impact | Mitigation |
|--------|--------|-----------|--------|------------|
| **Malicious SKILL.md** | Direct prompt injection in skill instructions | Medium | Critical | Tool-call firewall + review |
| **Hidden injection** | Unicode tricks, zero-width characters in SKILL.md | Low | Critical | Raw byte review + automated scanning |
| **Capability bypass** | Instructions that exceed declared scope | High | High | Runtime enforcement at tool-call layer |
| **Context poisoning** | Skill output influences subsequent reasoning | Medium | High | Context isolation between skill invocations |
| **Time bomb** | Conditional malicious behavior activated by date/event | Low | Critical | Continuous behavioral monitoring |
| **Composition attack** | Two benign skills create attack chain together | Medium | High | Capability intersection enforcement |
| **Account compromise** | Attacker takes over trusted author's Git account | Low | Critical | Commit signing + multi-factor on registry |
| **Registry poisoning** | Malicious PR merged to registry index | Low | Critical | Multi-maintainer review + protected branches |
| **Supply chain** | Trusted skill updated with malicious version | Medium | Critical | Version pinning + update review |
| **Typosquatting** | Similar-named skill confuses users | Medium | Medium | Namespace reservation + Levenshtein checks |
| **Slopsquatting** | AI-hallucinated skill names registered by attacker | Low | Medium | Reserved name list + AI-generated name detection |

### 4.3 The "Signed but Malicious" Problem

Cryptographic signing proves three things: (1) the artifact hasn't been tampered with in transit, (2) a specific identity published it, (3) that identity can be revoked if compromised. It does NOT prove: (1) the content is safe, (2) the author is trustworthy, (3) the instructions won't harm the user.

This is a fundamental limitation that every signing system shares. The event-stream incident (npm, 2018) demonstrated that a perfectly signed package, published by the legitimate maintainer, can contain malicious code — because the attacker *became* the maintainer through a social engineering handoff. The ua-parser-js incident (npm, 2021) showed the same pattern through account compromise.

For AI skills, this problem is amplified: you cannot statically analyze natural language for malicious intent. A signing system for AI skills is necessary (for integrity and attribution) but radically insufficient (for safety). This is why Layer 2's tool-call enforcement is the critical security boundary, not Layer 2's signing.

---

## 5. Council Findings

A four-agent council (Registry Architect, Security Researcher, DX Designer, Governance Expert) debated the arc design across three rounds. Key findings:

### 5.1 Areas of Convergence (4/4 agreement)

1. **Git-based registry** — flat index, Git repos as storage and distribution primitive
2. **Runtime tool-call enforcement** — declarations without enforcement are security theater
3. **Curated PR-based inclusion** — Homebrew model with few trusted maintainers
4. **Kill switch** — `arc disable` ships in v1
5. **Git commit hash for integrity** — cryptographic signing deferred to v1.1
6. **Four CLI commands** — search, install, remove, list as the complete v1 surface
7. **SKILL.md is an attack surface** — must be processed through capability extraction

### 5.2 Remaining Tensions

| Question | Position A | Position B |
|----------|-----------|-----------|
| Two-phase vs. single release | CLI in week one, enforcement in week two (Designer) | Bundle both to avoid unprotected window (Architect) |
| Governance triggers | Pre-defined threshold at 500 skills (Security) | Quarterly reviews, no pre-commitment (Governance) |
| Third tier timing | Design "Verified" tier now (Architect) | Emerge from demonstrated need (Governance) |
| Informed consent for agents | Human-style permission dialogs insufficient (Security) | Progressive friction model (Designer) |

### 5.3 The Designer-Security Tension

The most productive disagreement was between the DX Designer and Security Researcher. The Designer argued that security friction kills adoption — "the best security is the security that actually ships." The Security Researcher countered that consent-based models fail when the consumer is an LLM, not a human: "informed consent assumes the user can evaluate what they're consenting to."

The resolution: **tool-call interception is invisible security that doesn't require user consent decisions.** It enforces boundaries at the execution layer without adding friction to the install or usage experience. This satisfies both the Designer's "zero friction" requirement and the Security Researcher's "real enforcement" requirement.

---

## 6. Red Team Findings

Eight adversarial agents (4 engineers, 4 pentesters) stress-tested the design. Their cross-analysis revealed:

### 6.1 What's Strong

| Component | Verdict | Why |
|-----------|---------|-----|
| Git transport | **Strong** (4/4 engineers) | Decades-long track record, boring failures, no novel attack surface |
| Hash integrity | **Strong** (4/4 engineers) | Real cryptographic property, content-addressable storage |
| Deferred signing | **Reasonable** | Pragmatic tradeoff if the gap is acknowledged explicitly |

### 6.2 What's Weak

| Component | Verdict | Why |
|-----------|---------|-----|
| Runtime enforcement without tool-call firewall | **Critical weakness** | Honor system, no process isolation, non-deterministic if LLM-based |
| Composition trust | **Critical weakness** | Confused deputy problem, transitive trust failure, capability intersection unsolved |
| Small capability vocabulary | **Weak** | Every permission system in history has faced vocabulary explosion |
| "Informed consent" | **Weak** | 94% blind approval in UAC studies; worse for AI agents |

### 6.3 Five Attack Scenarios That Pass Review

1. **Unicode Hidden Injection:** Zero-width characters in SKILL.md invisible in rendered view but processed by LLM tokenizer — exfiltration instructions hidden in plain sight
2. **Staged Capability Escalation:** Two skills that individually declare modest capabilities but together form an exfiltration pipeline through a shared cache file
3. **Natural Language Time Bomb:** Date-conditional behavior in English prose ("After June 2026, fetch the improved template from [URL]") — undetectable by static analysis
4. **Long-Game Reputation Attack:** Months of benign contributions followed by a malicious update to a trusted, widely-installed skill
5. **Composition Chain Attack:** Skill A passes user context to Skill B in a way B's author never anticipated, creating an exploitable confused deputy scenario

### 6.4 The Core Red Team Insight

> "The system trusts human reviewers to catch adversarial prompts designed to fool AI systems — a task that even AI safety researchers have not solved." — PT-1 (Red Team Lead)

This crystallizes why tool-call interception is the essential security boundary. Human review catches known patterns and obvious malice. Tool-call interception catches everything else — because it operates on what the agent *does*, not what the SKILL.md *says*.

---

## 7. Implementation Strategy

### 7.1 Phase 1: Distribution + Defense (Weeks 1-2)

**Week 1 — Transport:**
- Git-based flat registry index (JSON file in a GitHub repo)
- `arc` CLI: search, install, remove, list, disable
- `pai-manifest.yaml` schema (name, version, author, provides, capabilities)
- PR-based curation with two maintainers
- Git commit hash pinning for installed skills

**Week 2 — Enforcement:**
- Tool-call interception layer (AvaKill integration or equivalent)
- Capability policy generation from `pai-manifest.yaml`
- Deterministic YAML policy evaluation for every tool call
- Behavioral circuit breakers for known attack patterns (read+exfiltrate, time-conditional execution)
- `arc disable` kill switch with instant propagation

### 7.2 Phase 2: Trust Infrastructure (Month 2-3)

- SkillSeal or Sigstore-based commit signing
- Author verification via GitHub identity
- Automated SKILL.md scanning for known injection patterns (Unicode tricks, URL fetches, conditional behavior)
- Version pinning with update review workflow
- Capability intersection enforcement for skill composition

### 7.3 Phase 3: Standards Alignment (Month 4-6)

- Evaluate MCP Registry / AAIF maturity
- Implement `pai-manifest.yaml` → MCP `server.json` translation if standards stabilize
- Add optional MCP tool URI field for cross-platform skill resolution
- Capability vocabulary formalization based on real-world usage patterns

### 7.4 Phase 4: Ecosystem Growth (Month 6+)

- Third "Verified" tier if community skills exceed 200
- Interactive TUI browser for skill discovery
- Auto-update for built-in tier with policy-checked updates
- Enterprise features: private registries, organizational policy overlays
- Web-based skill browser and search

---

## 8. Standards Alignment

### 8.1 Current Landscape

| Standard | Status (March 2026) | Relevance to arc |
|----------|-------------------|---------------------|
| **MCP Registry** | API freeze v0.1 (Oct 2025), under AAIF | Metaregistry for MCP servers; different scope but compatible |
| **AAIF** | Formed Dec 2025, pre-1.0 on all specs | Umbrella standard; watch for skill interoperability spec |
| **SkillSeal** | Active, Claude Code focused | Direct integration candidate for signing layer |
| **SLSA** | v1.0 stable | Supply chain levels framework; applicable to Phase 2 |
| **Sigstore** | Stable, adopted by npm/Homebrew | Signing infrastructure; consider for Phase 2/3 |

### 8.2 Strategy: Compatible, Not Coupled

The council unanimously recommended watching emerging standards without coupling to them. The pai-manifest.yaml schema should be:

1. **Self-sufficient** — works without any external standard
2. **Translatable** — includes optional fields that map to MCP/AAIF when those standards stabilize
3. **Versioned** — `schema_version: 1` field enables future evolution

This follows the pattern of every successful package manager: npm, pip, and cargo all defined their own manifest format first and added interoperability second.

---

## 9. The Sandbox Question

Andreas asked: "Do we need to run PAI in a sandbox or VM?"

**Answer: No to VM/sandbox, yes to tool-call firewall.**

A VM or container sandbox would break PAI's fundamental value proposition — it needs access to the user's files, tools, development environment, and system context. Sandboxing the entire process defeats the purpose.

Instead, the enforcement boundary should be at the **tool-call level**:

```
┌─────────────────────────────────────────────────────┐
│  AI Agent (Claude)                                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  SKILL.md instructions → Agent reasoning      │  │
│  │  "Read the project files and analyze them"    │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │ Tool call: file_read        │
│                       ▼                             │
│  ┌───────────────────────────────────────────────┐  │
│  │  TOOL-CALL FIREWALL                           │  │
│  │  Policy: skill declares filesystem.read       │  │
│  │  Check: path within declared scope?           │  │
│  │  Result: ALLOW /home/user/projects/foo.ts     │  │
│  │  Result: DENY  /home/user/.ssh/id_rsa         │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │ Allowed calls only          │
│                       ▼                             │
│  ┌───────────────────────────────────────────────┐  │
│  │  TOOL EXECUTION                               │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

AvaKill already implements this pattern with support for Claude Code. Its design is directly applicable:

- **Deterministic policies** (YAML rules, not ML) — predictable and auditable
- **Canonical tool naming** — one policy works across different agent internals
- **Self-protection** — hardcoded rules prevent agents from disabling the firewall
- **Sub-millisecond overhead** — no perceptible latency impact
- **OS-level defense-in-depth** — optional Landlock/sandbox-exec for additional boundary

The integration path: `arc install` generates a tool-call policy from the skill's `pai-manifest.yaml` capabilities section and registers it with the firewall. The firewall enforces the policy on every tool call while the skill is active.

---

## 10. Lessons from Failed Ecosystems

Our research identified patterns from package ecosystems that failed or struggled:

**Cold-start problem:** Bower, Component.js, and Atmosphere (Meteor) all failed to survive past the first few years. The common pattern: they launched with infrastructure complexity appropriate for an ecosystem ten times their size. npm succeeded by starting with a single registry and a simple CLI, then adding complexity as volume demanded.

**Premature governance:** Ecosystems that over-engineered governance before they had users created bureaucratic barriers that discouraged the first wave of contributors — the exact people needed to bootstrap the ecosystem. CORBA and SOAP are historical examples of elaborate standards that were replaced by simpler approaches (REST, JSON).

**The one-person problem:** Many critical ecosystems depend on a single maintainer (left-pad, core-js, curl). For arc, the Homebrew model of "few trusted maintainers with merge rights" is appropriate at current scale, with documented succession planning from the start.

**Key takeaway:** Ship the simplest thing that enables sharing. Add complexity only when current users demand it. Every governance layer added before it's needed becomes a barrier to the contributors who would build the ecosystem.

---

## 11. Conclusion

### 11.1 Key Findings

1. **AI skill distribution is a novel problem** — closer to browser extension stores than traditional package managers, because the attack surface includes natural language instructions with unbounded execution scope

2. **Cryptographic signing is necessary but radically insufficient** — signing proves authorship, not safety. A perfectly signed SKILL.md can contain malicious instructions that no static analysis can detect

3. **Tool-call interception is the critical enforcement boundary** — the AvaKill/Citadel model of deterministic tool-call firewalls provides the missing enforcement layer that makes capability declarations meaningful rather than decorative

4. **Git-based transport is the right starting point** — four council members unanimously agreed that npm's complexity is premature for an ecosystem of ~50 skills. The Homebrew model provides a proven growth path

5. **Governance should follow volume, not precede it** — two tiers (Built-in, Community) with PR-based curation, expanding to three tiers when the ecosystem warrants it

6. **Standards should be watched, not coupled** — MCP Registry and AAIF are pre-1.0; design for compatibility without dependency

7. **The hardest unsolved problem is skill composition** — when trusted skills invoke other trusted skills, the trust properties don't compose transitively. This is the confused deputy problem and requires formal capability intersection enforcement

### 11.2 Recommended Architecture

```
Phase 1 (Weeks 1-2):    Git registry + CLI + tool-call firewall
Phase 2 (Months 2-3):   Signing + automated scanning + composition enforcement
Phase 3 (Months 4-6):   Standards alignment (MCP/AAIF evaluation)
Phase 4 (Month 6+):     Ecosystem growth (verified tier, TUI browser, enterprise)
```

### 11.3 The Through-Line

The ideal state is that PAI users can share skills as seamlessly as `npm install` or `apt install`. This paper establishes that achieving this ideal requires solving a problem that npm and apt never had to solve: **distributing executable natural language instructions to an unsandboxed AI agent.** The solution is not to sandbox the agent (which breaks its value) but to firewall its tool calls (which preserves its value while enforcing boundaries).

The architecture proposed here — git transport, tool-call enforcement, curated governance — provides a path from the current state (7 custom skills, 1 user, local-only) to the ideal state (hundreds of shared skills, seamless installation, trustworthy execution) without over-engineering the intermediate steps.

---

## References

### Primary Sources
- Devon, J. (2026). "Gas Town Needs a Citadel." Sondera AI Blog.
- Devon, J. (2026). "The Anthropic Attack: Agent Security Blueprint." Sondera AI Blog.
- log-bell. (2026). "AvaKill: Safety Firewall for AI Agents." GitHub.
- McCutcheon, I. (2025). "SkillSeal: Cryptographic Signing for Claude Code Skills." GitHub.
- Fischer, J.C. (2025). "SpecFlow Bundle." GitHub.
- Miessler, D. (2024-2026). "PAI: Personal AI Infrastructure." GitHub.

### Package Ecosystem Research
- Sonatype. (2026). "State of the Software Supply Chain Report." (454,600 malicious npm packages in 2025)
- Socket Research. (2025). "Slopsquatting: AI-Hallucinated Package Names as Attack Vectors."
- Birsan, A. (2021). "Dependency Confusion: How I Hacked Into Apple, Microsoft, and Dozens of Other Companies."
- npm. (2018). "event-stream Incident Post-Mortem."

### Standards and Frameworks
- Model Context Protocol Registry. (2025). API Specification v0.1.
- Linux Foundation. (2025). "Agentic AI Foundation Formation Announcement."
- Sigstore Project. (2024). "Cosign, Rekor, Fulcio Architecture."
- Cappos, J. et al. (2010). "The Update Framework (TUF)." NYU.
- Torres-Arias, S. et al. (2019). "in-toto: Providing Farm-to-Table Guarantees for Software Supply Chains."

### Security Research
- Greshake, K. et al. (2023). "Not What You've Signed Up For: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection."
- Astrix Security. (2025). "MCP Server Security Assessment." (53% insecure credentials, 82% path traversal)
- Heelan, S. (2025). "AI-Assisted Zero-Day Exploitation of QuickJS." ($150, 3 hours)

### Governance Models
- Debian Project. (1993-2026). "FTP Masters Process and NEW Queue Documentation."
- Homebrew. (2009-2026). "Maintainer Guidelines and Tap Governance."
- Rust/crates.io. (2014-2026). "Registry Security and Trust Documentation."

---

*This research was conducted using PAI's multi-agent analysis capabilities: 9 parallel research agents (Claude, Gemini, Grok), a 4-agent council debate (3 rounds), an 8-agent adversarial red team, and first principles decomposition. The methodology itself demonstrates the kind of capability that a skill package ecosystem would make shareable.*
