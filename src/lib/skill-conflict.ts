import { cp, lstat, mkdir, rename, rm } from "fs/promises";
import { join } from "path";
import { isErrno } from "./errors.js";
import { spawnEnv, userHome } from "./user-home.js";

/**
 * What the principal chose for a skill target that something other than arc
 * already occupies (soma-lifeos#17). `replace` backs the existing path up and
 * links the package's skill; `keep` leaves it and skips the link.
 */
export type SkillConflictChoice = "replace" | "keep";

/** An occupied skill target: `target` holds content arc did not link there. */
export interface SkillConflict {
  name: string;
  target: string;
  /** The package's skill directory, the link arc would create at `target`. */
  source: string;
}

/**
 * Decides one conflict. `"refuse"` aborts the install before any filesystem
 * change; it is the answer when nobody can be asked and no `--on-conflict`
 * was given.
 */
export type SkillConflictResolver = (conflict: SkillConflict) => Promise<SkillConflictChoice | "refuse">;

export const refuseSkillConflicts: SkillConflictResolver = () => Promise.resolve("refuse");

/** The terminal seam for {@link promptSkillConflict}. `read` resolves null at end of input. */
export interface SkillConflictIO {
  read(): Promise<string | null>;
  write(text: string): void;
  diff(existing: string, packageDir: string): string;
  page(text: string): Promise<void>;
  home?: string;
}

const ON_CONFLICT_CHOICES: readonly SkillConflictChoice[] = ["replace", "keep"];

/** Parse `--on-conflict`. Absent stays undefined; anything but replace|keep throws. */
export function parseOnConflict(raw: string | undefined): SkillConflictChoice | undefined {
  if (raw === undefined) return undefined;
  const choice = ON_CONFLICT_CHOICES.find((c) => c === raw);
  if (!choice) {
    throw new Error(`--on-conflict must be 'replace' or 'keep' (got '${raw}')`);
  }
  return choice;
}

/**
 * The Soma registry slot `soma project-skill` claims for a skill: the same
 * `$SOMA_HOME` (default `~/.soma`) the spawned soma resolves.
 */
export function somaSkillSlot(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SOMA_HOME?.trim();
  const somaHome = configured === undefined || configured === "" ? join(userHome(), ".soma") : configured;
  return join(somaHome, "skills", name);
}

function tildify(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** How a principal takes back a `kept` answer (soma-lifeos#17). */
export function keptSkillHint(name: string): string {
  return `Your own copy of '${name}' was kept. Run \`arc remove ${name}\`, then install again to choose replace or keep.`;
}

export function skillConflictRefusalReason(conflict: SkillConflict): string {
  return (
    `Skill '${conflict.name}' already exists at ${conflict.target} (not installed by arc). ` +
    `Run arc in a terminal to choose, or pass --on-conflict replace|keep`
  );
}

export function formatSkillConflictRefusals(conflicts: { target: string; reason: string }[]): string {
  return `skill targets refused:\n${conflicts.map((c) => `  - ${c.reason}`).join("\n")}`;
}

/**
 * Ask about one occupied skill target, apt-style: `r` replace, `k` keep
 * (also Enter and end of input), `d` show the diff and ask again. Anything
 * else re-asks.
 */
export async function promptSkillConflict(
  conflict: SkillConflict,
  io: SkillConflictIO,
): Promise<SkillConflictChoice> {
  const home = io.home ?? userHome();
  io.write(
    `Skill '${conflict.name}' already exists at ${tildify(conflict.target, home)} (not installed by arc).\n` +
      `  [r] replace it with the package's version (yours is kept as a backup)\n` +
      `  [k] keep yours and skip this skill\n` +
      `  [d] show the differences, then ask again\n`,
  );
  for (;;) {
    io.write("Choice [k]: ");
    const line = await io.read();
    if (line === null) {
      io.write("\n");
      return "keep";
    }
    const answer = line.trim().toLowerCase();
    if (answer === "" || answer === "k") return "keep";
    if (answer === "r") return "replace";
    if (answer === "d") {
      await io.page(io.diff(conflict.target, conflict.source));
      continue;
    }
    io.write("Please answer r, k or d.\n");
  }
}

/** `diff -ru` of the existing path against the package's skill directory. */
export function diffSkillTarget(existing: string, packageDir: string): string {
  const result = Bun.spawnSync(["diff", "-ru", existing, packageDir], {
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv(),
  });
  if (result.exitCode === 0) return "No differences.\n";
  const out = result.stdout.toString() + result.stderr.toString();
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** True when `text` has more lines than a terminal of `rows` rows can show. */
export function needsPager(text: string, rows: number | undefined): boolean {
  if (!rows || rows <= 0) return false;
  return text.split("\n").length - 1 > rows;
}

async function pageToTerminal(text: string): Promise<void> {
  if (!needsPager(text, process.stdout.rows)) {
    process.stdout.write(text);
    return;
  }
  const configured = process.env.PAGER?.trim();
  const pager = configured === undefined || configured === "" ? "less" : configured;
  try {
    const proc = Bun.spawn(["sh", "-c", pager], {
      stdin: new TextEncoder().encode(text),
      stdout: "inherit",
      stderr: "inherit",
      env: spawnEnv(),
    });
    await proc.exited;
  } catch {
    process.stdout.write(text);
  }
}

const pendingLines: string[] = [];
let partialLine = "";

function readTerminalLine(): Promise<string | null> {
  const queued = pendingLines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  const stdin = process.stdin;
  if (stdin.readableEnded) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (line: string | null) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      resolve(line);
    };
    const onData = (data: string) => {
      const lines = (partialLine + data).split("\n");
      partialLine = lines.pop() ?? "";
      if (lines.length === 0) return;
      pendingLines.push(...lines.slice(1));
      finish(lines[0]);
    };
    const onEnd = () => {
      const rest = partialLine;
      partialLine = "";
      finish(rest === "" ? null : rest);
    };
    stdin.setEncoding("utf-8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

export function terminalSkillConflictIO(): SkillConflictIO {
  return {
    read: readTerminalLine,
    write: (text) => process.stdout.write(text),
    diff: diffSkillTarget,
    page: pageToTerminal,
  };
}

/**
 * The resolver `arc install` / `arc upgrade` use. An explicit `--on-conflict`
 * answers every conflict; otherwise an interactive terminal is asked, and
 * without one the conflict is refused. `--yes` plays no part.
 */
export function skillConflictResolver(opts: {
  onConflict?: SkillConflictChoice;
  interactive: boolean;
  io?: SkillConflictIO;
}): SkillConflictResolver {
  const { onConflict } = opts;
  if (onConflict) return () => Promise.resolve(onConflict);
  if (!opts.interactive) return refuseSkillConflicts;
  const io = opts.io ?? terminalSkillConflictIO();
  return (conflict) => promptSkillConflict(conflict, io);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (!isErrno(err) || err.code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Move an occupied skill target to `<stateRoot>/backups/<timestamp>/<name>`,
 * outside every skills directory, and return the backup path.
 */
export async function backupSkillTarget(
  target: string,
  name: string,
  stateRoot: string,
  now: Date = new Date(),
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let dir = join(stateRoot, "backups", stamp);
  for (let n = 1; await exists(join(dir, name)); n++) {
    dir = join(stateRoot, "backups", `${stamp}-${n}`);
  }
  await mkdir(dir, { recursive: true });
  const backup = join(dir, name);
  await move(target, backup);
  return backup;
}

/** Put a backup taken by {@link backupSkillTarget} back at its original path. */
export async function restoreSkillBackup(backup: string, target: string): Promise<void> {
  if (await exists(target)) {
    throw new Error(`cannot restore ${backup}: ${target} is occupied`);
  }
  await move(backup, target);
}
