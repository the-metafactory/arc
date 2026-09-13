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

export interface SpawnSite {
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line of the callee. */
  readonly line: number;
  /** `Bun.spawnSync`, `execSync`, … */
  readonly callee: string;
  /** True when the call's arguments mention an `env` property. */
  readonly hasEnv: boolean;
  /**
   * The program being run, when the call site states it as a literal —
   * `Bun.spawnSync(["git", …])` → `git`. `null` when the argv (or its head) is
   * computed, which is precisely the case that can never be exempted by
   * command name.
   */
  readonly argvHead: string | null;
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

/** Does this argument text name an `env` property (`env:` or shorthand `env`)? */
function mentionsEnv(args: string): boolean {
  const mask = codeMask(args);
  for (let i = 0; i + 2 < args.length; i++) {
    if (!mask[i]) continue;
    if (args.slice(i, i + 3) !== "env") continue;
    if (i > 0 && IDENT.test(args[i - 1])) continue;
    let j = i + 3;
    while (j < args.length && /\s/.test(args[j])) j++;
    // `env:` (property), `env,` / `env}` (shorthand in an options object).
    if (args[j] === ":" || args[j] === "," || args[j] === "}") return true;
  }
  return false;
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
    sites.push({
      file,
      line,
      callee,
      hasEnv: mentionsEnv(text),
      argvHead: argvHeadOf(text),
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
