import { describe, test, expect, afterAll } from "bun:test";
import {
  detectAccount,
  addBot,
  removeBot,
  __setNscRunnerForTests,
  __setNscInstallCheckForTests,
} from "../../src/commands/nats.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnEnv, userHome } from "../../src/lib/user-home.js";

/**
 * Every `nsc` spawn below passes `env`, and the creds path resolves through
 * `userHome()` — arc#421 round 3.
 *
 * These probes run at MODULE LOAD, before any hook, and `Bun.spawnSync(argv)`
 * with no `env` hands the child the SPAWN-time environ rather than the pinned
 * `process.env`. So `nsc list accounts` and `nsc push --diff` ran against the
 * operator's REAL store and created `~/.config/nats/nsc/nsc.json` there on any
 * box with nsc installed — one of the two writes keeping the real-home guard
 * red. With the sandbox env threaded through they probe the sandbox, find no
 * operator, and the environment-dependent cases skip: which is what a test that
 * must not read the operator's store should do.
 */
const nsc = (args: string[]) =>
  Bun.spawnSync(["nsc", ...args], { stdout: "pipe", stderr: "pipe", env: spawnEnv() });

const NSC_AVAILABLE =
  Bun.spawnSync(["which", "nsc"], { stdout: "pipe", env: spawnEnv() }).exitCode === 0;
const TEST_ACCOUNT = "OP_JC";
const TEST_BOT = "arc-test-bot";
const CREDS_PATH = join(userHome(), ".config", "nats", `${TEST_BOT}.creds`);

// Fixtures for the seam-driven creds-permission test at the bottom of the file.
const FAKE_USER_PUBKEY = "UAFAKEPUBKEYFORARCUNITTESTUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU";
const FAKE_USER_JWT_JSON = JSON.stringify({
  jti: "fake",
  iat: 0,
  iss: "AACCOUNT",
  sub: FAKE_USER_PUBKEY,
  name: "creds-perm-bot",
  nats: { type: "user" },
});
const FAKE_CREDS = [
  "-----BEGIN NATS USER JWT-----",
  "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.fakebody.fakesig",
  "-----END NATS USER JWT-----",
  "",
  "-----BEGIN USER NKEY SEED-----",
  "SUAFAKESEED",
  "-----END USER NKEY SEED-----",
].join("\n");

// The validation tests below spawn the CLI which calls `nsc add user ...`,
// which fails up-front with "account not in operator" if the test account
// isn't registered under whoever the active operator happens to be. The
// error message in that case has nothing to do with subject validation, so
// these tests are environment-skewed unless the operator carries OP_JC.
// Skip cleanly when the account isn't available rather than asserting on
// an unrelated nsc failure (was producing flake — see arc#138 sweep).
/**
 * An nsc STORE this run can actually read — not merely an nsc binary on PATH.
 *
 * `which nsc` was standing in for both, which only worked while the probes
 * silently addressed the operator's real store. Now that they address the
 * sandbox, "the binary exists" and "there is an operator configured" are
 * different questions and the store-dependent cases gate on this one.
 */
const NSC_STORE_READY = NSC_AVAILABLE && nsc(["list", "accounts"]).exitCode === 0;

const TEST_ACCOUNT_AVAILABLE = (() => {
  if (!NSC_STORE_READY) return false;
  const probe = nsc(["list", "accounts"]);
  return probe.exitCode === 0 && probe.stdout.toString().includes(TEST_ACCOUNT);
})();

// `removeBot` now requires server-side revocation push (#130). The local nsc
// lifecycle test only runs against an operator whose JWT carries a reachable
// account-jwt-server URL. `nsc push --diff` is non-destructive and reports
// the same connectivity error as a real push, so we use it as a probe.
// Coverage of revocation call-order + abort semantics without a server lives
// in test/commands/nats-revoke.test.ts.
const NATS_REACHABLE = (() => {
  if (!NSC_AVAILABLE) return false;
  return nsc(["push", "-a", TEST_ACCOUNT, "--diff"]).exitCode === 0;
})();

function cleanupTestBot(): void {
  nsc(["delete", "user", "-a", TEST_ACCOUNT, "-n", TEST_BOT]);
  try { unlinkSync(CREDS_PATH); } catch { /* ok */ }
  try { unlinkSync(`${CREDS_PATH}.bak`); } catch { /* ok */ }
}

afterAll(() => {
  if (!NSC_AVAILABLE) return;
  cleanupTestBot();
});

describe("nats commands", () => {
  describe("detectAccount", () => {
    test.skipIf(!NSC_STORE_READY)("detects current account from nsc config", () => {
      const account = detectAccount();
      expect(typeof account).toBe("string");
      expect(account.length).toBeGreaterThan(0);
    });
  });

  describe("addBot + removeBot lifecycle", () => {
    test.skipIf(!NATS_REACHABLE)("creates user, writes creds with correct perms, removes cleanly", () => {
      cleanupTestBot();

      addBot(TEST_BOT, { account: TEST_ACCOUNT });

      expect(existsSync(CREDS_PATH)).toBe(true);
      const stat = statSync(CREDS_PATH);
      expect(stat.mode & 0o777).toBe(0o600);

      const content = readFileSync(CREDS_PATH, "utf-8");
      expect(content).toContain("BEGIN NATS USER JWT");
      expect(content).toContain("BEGIN USER NKEY SEED");

      removeBot(TEST_BOT, { account: TEST_ACCOUNT, deleteCreds: true });
      expect(existsSync(CREDS_PATH)).toBe(false);
    });
  });

  describe("subject validation", () => {
    test.skipIf(!NSC_AVAILABLE || !TEST_ACCOUNT_AVAILABLE)("rejects subjects with shell metacharacters via CLI", () => {
      const result = Bun.spawnSync(["bun", "src/cli.ts", "nats", "add-bot", "subj-test",
        "-a", TEST_ACCOUNT, "--pub", "valid.subject,$(evil)",
      ], { cwd: join(import.meta.dir, "../.."), stderr: "pipe", env: spawnEnv() });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Invalid NATS subject");
    });

    test.skipIf(!NSC_AVAILABLE || !TEST_ACCOUNT_AVAILABLE)("rejects invalid bot name via CLI", () => {
      const result = Bun.spawnSync(["bun", "src/cli.ts", "nats", "add-bot", "UPPER-CASE",
        "-a", TEST_ACCOUNT,
      ], { cwd: join(import.meta.dir, "../.."), stderr: "pipe", env: spawnEnv() });

      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("creds directory permissions", () => {
    /**
     * Was `if (existsSync(~/.config/nats)) expect(mode).toBe(0o700)`, gated on
     * `which nsc` — so it asserted on whatever directory happened to be at that
     * path, and passed vacuously everywhere else. Under a pinned sandbox home
     * that path is shared with every other test, which makes the claim false
     * rather than merely weak.
     *
     * Driven through the nsc seam against a home of its own instead: arc creates
     * the default creds dir itself, and the mode is arc's to guarantee. Runs
     * everywhere, including CI, with no nsc installed.
     */
    test("arc creates its default creds dir at mode 700", async () => {
      const home = mkdtempSync(join(tmpdir(), "arc-creds-home-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      __setNscInstallCheckForTests(() => true);
      __setNscRunnerForTests((args) => {
        const key = args.slice(0, 2).join(" ");
        if (key === "describe user") {
          return args.includes("-J")
            ? { exitCode: 0, stdout: FAKE_USER_JWT_JSON, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "user not found" };
        }
        if (key === "add user") return { exitCode: 0, stdout: "added", stderr: "" };
        if (key === "generate creds") return { exitCode: 0, stdout: FAKE_CREDS, stderr: "" };
        throw new Error(`unexpected: nsc ${args.join(" ")}`);
      });

      try {
        const result = await addBot("creds-perm-bot", { account: "OP_PERM", json: true });
        const dir = join(home, ".config", "nats");
        expect(result.credsPath).toBe(join(dir, "creds-perm-bot.creds"));
        expect(existsSync(dir)).toBe(true);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(result.credsPath).mode & 0o777).toBe(0o600);
      } finally {
        __setNscRunnerForTests(null);
        __setNscInstallCheckForTests(null);
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
