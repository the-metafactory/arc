/**
 * END-TO-END integration test for `arc nats add-federation-export` (cortex#1225
 * provision-chain hardening).
 *
 * Unlike `nats-federation.test.ts` (which injects a fake runner via
 * `__setNscRunnerForTests`), this test exercises the FULL real process chain:
 *
 *     spawn `arc nats add-federation-export … --apply --json`
 *        → real arc CLI code
 *        → real `Bun.spawnSync(["nsc", …])`
 *        → a fake `nsc` EXECUTABLE resolved from the child's start-time PATH
 *
 * Command-name resolution uses the spawned process's START-TIME PATH, so a fake
 * `nsc` placed first on the child's PATH genuinely shadows the real binary
 * (an in-process PATH mutation cannot — Bun snapshots PATH for lookup). The fake
 * `nsc` enforces real nsc/commander semantics: each verb accepts only its
 * documented flags and exits non-zero with "unknown flag: …" otherwise.
 *
 * This is the anti-rot guard that bites if arc ever emits the wrong nsc argv
 * again — it catches BOTH original bugs end-to-end:
 *   1. `add import --from-account <name> --subject …` (nsc wants
 *      `--src-account <pubkey> --remote-subject --local-subject`)
 *   2. `nsc push` on a resolver:MEMORY operator (no account-JWT server)
 *
 * No real nsc operator, no live hub, no network — a hermetic fake binary.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const FROM_ACCOUNT = "ANDREAS_WORK_FED";
const TO_ACCOUNT = "ANDREAS_WORK_AGENTS";
const FROM_PUBKEY = "AABUTRYJRBAT64IYTBWFABYWORP634GY75SO52EIPOHVLBFVOTCWTUOJ";

// arc CLI entrypoint, resolved from this test file (test/commands → repo root).
const ARC_CLI = resolve(import.meta.dir, "../../src/cli.ts");

let tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

/**
 * Write a fake `nsc` executable that mimics real nsc's commander flag-rejection
 * and emits minimal JSON for the `describe` verbs. `accountServerUrl` controls
 * whether `describe operator` reports an account-JWT server (push-gating).
 */
function makeFakeNscDir(opts: { accountServerUrl?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-fake-nsc-"));
  tempDirs.push(dir);
  const accountServer = opts.accountServerUrl
    ? `,\\"account_server_url\\":\\"${opts.accountServerUrl}\\"`
    : "";
  const script = `#!/usr/bin/env bash
set -u
verb="\${1:-}"; noun="\${2:-}"
key="$verb"
if [[ -n "$noun" && "\${noun:0:1}" != "-" ]]; then key="$verb $noun"; fi

allowed_for() {
  case "$1" in
    "add export")        echo "--account -a --subject -s --service -r --name -n" ;;
    "add import")        echo "--account -a --src-account --remote-subject --local-subject -s --service --name -n" ;;
    "push")              echo "-a --account -A --all" ;;
    "describe account")  echo "-n --name -J" ;;
    "describe operator") echo "-J -n --name" ;;
    *)                   echo "" ;;
  esac
}

allowed="$(allowed_for "$key")"
if [[ -n "$allowed" ]]; then
  for a in "$@"; do
    if [[ "\${a:0:1}" == "-" ]]; then
      ok=0
      for f in $allowed; do [[ "$a" == "$f" ]] && ok=1; done
      if [[ "$ok" == "0" ]]; then echo "Error: unknown flag: $a" >&2; exit 1; fi
    fi
  done
fi

case "$key" in
  "describe operator") echo "{\\"sub\\":\\"OOPERATOR\\",\\"nats\\":{\\"type\\":\\"operator\\"${accountServer}}}" ;;
  "describe account")  echo "{\\"sub\\":\\"${FROM_PUBKEY}\\",\\"nats\\":{\\"type\\":\\"account\\",\\"exports\\":[],\\"imports\\":[]}}" ;;
  *) : ;;
esac
exit 0
`;
  const path = join(dir, "nsc");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

interface FederationEnvelope {
  schema: string;
  ok: boolean;
  exportAdded?: boolean;
  importAdded?: boolean;
  pushResult?: { fromAccount: string; toAccount: string };
  error?: { code: string; message: string };
}

/** Spawn the real arc CLI with the fake nsc dir FIRST on the child's PATH. */
function runArcFederationExport(fakeDir: string): FederationEnvelope {
  const proc = Bun.spawnSync(
    [
      "bun", "run", ARC_CLI,
      "nats", "add-federation-export",
      "--from-account", FROM_ACCOUNT,
      "--to-account", TO_ACCOUNT,
      "--apply",
      "--json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ""}`, ARC_TEST_MODE: "1" },
    },
  );
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{")) ?? "";
  if (!line) {
    throw new Error(`arc emitted no JSON envelope.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return JSON.parse(line) as FederationEnvelope;
}

describe("add-federation-export — real arc→nsc subprocess chain (fake nsc binary)", () => {
  test("full --apply chain completes against a flag-strict fake nsc (MEMORY resolver → push skipped)", () => {
    const dir = makeFakeNscDir(); // no account server → resolver: MEMORY topology
    const env = runArcFederationExport(dir);

    // Whole chain SUCCEEDS — proving every nsc invocation used valid flags
    // (a wrong flag would exit 1 → arc surfaces ok:false / NSC_COMMAND_FAILED).
    expect(env.ok).toBe(true);
    expect(env.schema).toBe("arc.nats.federation.v1");
    expect(env.exportAdded).toBe(true);
    expect(env.importAdded).toBe(true);
    expect(env.pushResult).toEqual({ fromAccount: "skipped", toAccount: "skipped" });
  });

  test("full --apply chain completes against a fake nsc WITH an account server (push runs)", () => {
    const dir = makeFakeNscDir({ accountServerUrl: "nats://hub.example:4222" });
    const env = runArcFederationExport(dir);

    expect(env.ok).toBe(true);
    expect(env.exportAdded).toBe(true);
    expect(env.importAdded).toBe(true);
    expect(env.pushResult).toEqual({ fromAccount: "ok", toAccount: "ok" });
  });
});
