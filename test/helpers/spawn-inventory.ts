/**
 * A static inventory of every process-spawn site in this repository, and
 * whether each one passes an explicit `env`.
 *
 * ── Why this exists (arc#421 round 4, BLOCKER) ──────────────────────────────
 *
 * `Bun.spawnSync(argv)` with no `env` hands the child the SPAWN-time environ,
 * not the current `process.env`. An in-process `$HOME` pin — the one the test
 * preload sets — is therefore invisible across the boundary, and any child
 * that resolves its own home-rooted state writes into the OPERATOR'S REAL
 * HOME. Round 3 found two such children (real `cosign` writing `~/.sigstore`,
 * real `nsc` writing `~/.config/nats/nsc/nsc.json`) and fixed those two.
 *
 * That closed two instances, not the class. An inventory then found 334 spawn
 * sites, 9 of which passed an `env`; among the other 325 were `soma
 * project-skill --apply` (whose entire job is writing `~/.soma` and projecting
 * into `~/.claude`) and `bun install` (measured: 290 entries written into the
 * spawn-time home's bun cache during one suite run).
 *
 * Fixing instances is what round 3 already tried. This module makes the class
 * UNREPRESENTABLE instead: `test/unit/spawn-env-discipline.test.ts` fails on
 * any spawn site without an explicit `env`, with a narrow allowlist that must
 * carry a one-line reason per entry.
 *
 * ── The scanner ─────────────────────────────────────────────────────────────
 *
 * Deliberately a lexer, not a regex and not a full parser. It tracks string,
 * template and comment state so a spawn named inside a doc comment or a string
 * literal is not counted, then reads the call's balanced argument list and
 * asks whether an `env` property key appears in it. That is enough to answer
 * the only question here — "did the author say anything about the child's
 * environment?" — and it cannot be fooled by formatting.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** `child_process` functions that create a process and take an options bag. */
const CHILD_PROCESS_FNS = [
  "execSync",
  "execFileSync",
  "spawnSync",
  "execFile",
  "exec",
  "spawn",
  "fork",
] as const;

/**
 * What the call site says about the child's environment.
 *
 * ── Why the KEY is not enough (arc#421 round 5, BLOCKER) ────────────────────
 *
 * Round 4 asked only whether the token `env` appeared as a property key. That
 * is satisfied by `env: undefined`, which leaks exactly as badly as saying
 * nothing. Measured on bun 1.3.2 with `process.env.HOME` pinned in-process:
 *
 * ```
 *   omitted                 child HOME = spawn-time HOME       ← the leak
 *   env: undefined          child HOME = spawn-time HOME       ← same leak
 *   env: null               child HOME = spawn-time HOME       ← same leak
 *   env: {}                 child HOME unset → os.homedir()
 *                           falls back to getpwuid → the operator's REAL home
 *   env: { ...process.env } child HOME = the pin               ← correct
 * ```
 *
 * `runScript` (`src/lib/scripts.ts`) already carries an optional `env` on its
 * own options bag and `install-transaction.ts:573` already passes it through as
 * a possibly-`undefined` shorthand — so `env: opts.env` at the spawn is one
 * refactor away, and round 4's rule would have called it green.
 *
 * So the classification is on the VALUE, and only a value that provably carries
 * the caller's current `process.env` counts.
 */
export type EnvKind =
  /** No `env` property at all — the child gets the spawn-time environ. */
  | "absent"
  /** `spawnEnv()`, `process.env`, or an object spreading either. */
  | "pinned"
  /** `env: undefined` / `env: null` — identical to `absent` at runtime. */
  | "nullish"
  /** `env: {}` — no HOME at all, so the child falls back to getpwuid. */
  | "empty"
  /**
   * A bare identifier, a member expression, some other call, or an object
   * literal that never spreads the current environ. Cannot be shown to carry
   * the pin, and `env: opts.env` (undefined at runtime) is exactly this shape.
   */
  | "opaque";

export interface SpawnSite {
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line of the callee. */
  readonly line: number;
  /** `Bun.spawnSync`, `execSync`, … */
  readonly callee: string;
  /** True when the call's arguments mention an `env` property AT ALL. */
  readonly hasEnv: boolean;
  /** What that `env` property is actually WORTH. See {@link EnvKind}. */
  readonly envKind: EnvKind;
  /** The source text of the `env` value, trimmed — for the failure message. */
  readonly envText: string | null;
  /**
   * The program being run, when the call site states it as a literal —
   * `Bun.spawnSync(["git", …])` → `git`. `null` when the argv (or its head) is
   * computed, which is precisely the case that can never be exempted by
   * command name.
   */
  readonly argvHead: string | null;
  /**
   * The WHOLE balanced argument text of the call, newlines collapsed.
   *
   * Round 4's `git --global|--system` assertion filtered on `text` — one source
   * line — and 88 of the 306 no-`env` sites are multi-line calls whose `text`
   * is just `Bun.spawnSync(`. Assertions about what a child is ASKED TO DO must
   * read this, not the callee's line.
   */
  readonly args: string;
  /**
   * True when the argv array contains a `...spread`, so the flags the child
   * actually receives cannot be enumerated from the source.
   */
  readonly argvHasSpread: boolean;
  /** The source line, trimmed — for the failure message. */
  readonly text: string;
}

const IDENT = /[A-Za-z0-9_$]/;

/**
 * Split a file into "code" spans, skipping comments and string/template
 * literals. Returns the offsets of code characters as a boolean mask so the
 * caller can keep absolute offsets (and therefore line numbers) intact.
 */
function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length); // 1 = code
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // A template substitution is code again; treat it as code so a spawn
        // inside `${...}` is still seen.
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          let depth = 1;
          mask[i] = 1; mask[i + 1] = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            mask[i] = 1;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    mask[i] = 1;
    i++;
  }
  return mask;
}

/** Read the balanced `(...)` argument text starting at `open`. */
function argText(src: string, open: number): { text: string; end: number } {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return { text: src.slice(open + 1, i), end: i };
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 1;
    }
    i++;
  }
  return { text: src.slice(open + 1), end: src.length };
}

/**
 * The source text of the `env` property's VALUE, or `null` when no `env`
 * property appears at all.
 *
 * Shorthand (`{ cwd, env }`) yields the identifier `env` itself, which is
 * correct: a shorthand is a bare identifier whose runtime value the source
 * cannot show, and `env` being `undefined` is the whole point of the round-5
 * blocker.
 */
function envValueOf(args: string): string | null {
  const mask = codeMask(args);
  for (let i = 0; i + 2 < args.length; i++) {
    if (!mask[i]) continue;
    if (args.slice(i, i + 3) !== "env") continue;
    if (i > 0 && IDENT.test(args[i - 1])) continue;
    let j = i + 3;
    while (j < args.length && /\s/.test(args[j])) j++;

    // `env,` / `env}` — shorthand in an options object.
    if (args[j] === "," || args[j] === "}") return "env";
    if (args[j] !== ":") continue;

    // `env: <value>` — read to the matching `,` or `}` at depth 0.
    j++;
    const vmask = mask;
    let depth = 0;
    const start = j;
    while (j < args.length) {
      if (vmask[j]) {
        const c = args[j];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "}") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
      }
      j++;
    }
    return args.slice(start, j).trim();
  }
  return null;
}

/** Does an object-literal body spread the caller's current environ? */
function spreadsCurrentEnv(body: string): boolean {
  return /\.\.\.\s*(?:process\.env|spawnEnv\s*\(\s*\))/.test(body);
}

/** Classify what an `env` value is actually worth. See {@link EnvKind}. */
export function classifyEnv(value: string | null): EnvKind {
  if (value === null) return "absent";
  const v = value.replace(/\s+/g, " ").trim();
  if (v === "undefined" || v === "null") return "nullish";
  // `spawnEnv()` — the repo's own pin-carrying helper (src/lib/user-home.ts).
  if (/^spawnEnv\s*\(\s*\)$/.test(v)) return "pinned";
  // A direct reference to the live environ object.
  if (/^process\.env$/.test(v)) return "pinned";
  if (v.startsWith("{") && v.endsWith("}")) {
    const body = v.slice(1, -1).trim();
    if (body.length === 0) return "empty";
    return spreadsCurrentEnv(body) ? "pinned" : "opaque";
  }
  return "opaque";
}

/**
 * The literal program name at the head of the argv, or `null`.
 *
 * Handles the three shapes this repo uses: `(["git", …], opts)`,
 * `({ cmd: ["git", …] })`, and `("git …")` for the `exec` family. Anything
 * computed — a variable, a ternary, a template with a substitution — is
 * `null` on purpose.
 */
function argvHeadOf(args: string): string | null {
  const trimmed = args.replace(/^\s+/, "");
  const arrayAt = trimmed.startsWith("[")
    ? 0
    : (() => {
        const m = /^\{[\s\S]*?\bcmd\s*:\s*/.exec(trimmed);
        return m ? m[0].length : -1;
      })();

  if (arrayAt >= 0 && trimmed[arrayAt] === "[") {
    const m = /^\[\s*(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)/.exec(trimmed.slice(arrayAt));
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  }

  // `exec("git rev-parse …")` — a whole command line as one string.
  const asString = /^(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)/.exec(trimmed);
  if (asString) {
    const cmd = (asString[1] ?? asString[2] ?? asString[3] ?? "").trim();
    return cmd.split(/\s+/)[0] || null;
  }
  return null;
}

/**
 * Does the argv array contain a `...spread`?
 *
 * A spread is the one element shape that can inject an unbounded number of
 * extra words into the child's command line, so a `git` argv carrying one
 * cannot be shown to be free of `--global` / `--system` (arc#421 round 5,
 * MAJOR). A plain identifier element is exactly one word and is left alone.
 */
function argvHasSpreadIn(args: string): boolean {
  const trimmed = args.replace(/^\s+/, "");
  const arrayAt = trimmed.startsWith("[")
    ? 0
    : (() => {
        const m = /^\{[\s\S]*?\bcmd\s*:\s*/.exec(trimmed);
        return m ? m[0].length : -1;
      })();
  if (arrayAt < 0 || trimmed[arrayAt] !== "[") return false;
  const rest = trimmed.slice(arrayAt);
  const mask = codeMask(rest);
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (!mask[i]) continue;
    const c = rest[i];
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) return false; // end of the argv array
    } else if (depth === 1 && rest.startsWith("...", i)) return true;
  }
  return false;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Scan one file's source for spawn sites. */
export function scanSource(file: string, src: string): SpawnSite[] {
  const usesChildProcess = /from\s+["']node:child_process["']|require\(["'](node:)?child_process["']\)/.test(src);
  const mask = codeMask(src);
  const sites: SpawnSite[] = [];
  const lines = src.split("\n");

  const record = (calleeStart: number, callee: string, open: number): void => {
    const { text } = argText(src, open);
    const line = lineOf(src, calleeStart);
    const envText = envValueOf(text);
    sites.push({
      file,
      line,
      callee,
      hasEnv: envText !== null,
      envKind: classifyEnv(envText),
      envText,
      argvHead: argvHeadOf(text),
      args: text.replace(/\s+/g, " ").trim(),
      argvHasSpread: argvHasSpreadIn(text),
      text: (lines[line - 1] ?? "").trim(),
    });
  };

  const names = usesChildProcess
    ? ["Bun.spawnSync", "Bun.spawn", ...CHILD_PROCESS_FNS]
    : ["Bun.spawnSync", "Bun.spawn"];

  for (const name of names) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(name, from);
      if (at < 0) break;
      from = at + name.length;
      if (!mask[at]) continue;
      // Whole-identifier match: nothing identifier-ish on either side.
      const before = src[at - 1];
      if (before !== undefined && (IDENT.test(before) || before === ".")) continue;
      let j = at + name.length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== "(") continue;
      record(at, name, j);
    }
  }

  return sites.sort((a, b) => a.line - b.line);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "coverage"]);

function walkTs(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
}

/** Inventory every spawn site under the given repo-relative directories. */
export function collectSpawnSites(repoRoot: string, dirs: readonly string[]): SpawnSite[] {
  const files: string[] = [];
  for (const dir of dirs) {
    const full = join(repoRoot, dir);
    try {
      if (statSync(full).isDirectory()) walkTs(full, files);
    } catch {
      /* absent directory — nothing to scan */
    }
  }
  files.sort();
  return files.flatMap((f) => scanSource(relative(repoRoot, f), readFileSync(f, "utf8")));
}
