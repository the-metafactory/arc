import { describe, test, expect, afterAll } from "bun:test";
import { detectAccount, addBot, removeBot } from "../../src/commands/nats.js";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NSC_AVAILABLE = Bun.spawnSync(["which", "nsc"]).exitCode === 0;
const TEST_ACCOUNT = "OP_JC";
const TEST_BOT = "arc-test-bot";
const CREDS_PATH = join(homedir(), ".config", "nats", `${TEST_BOT}.creds`);

function cleanupTestBot(): void {
  Bun.spawnSync(["nsc", "delete", "user", "-a", TEST_ACCOUNT, "-n", TEST_BOT]);
  try { unlinkSync(CREDS_PATH); } catch { /* ok */ }
  try { unlinkSync(`${CREDS_PATH}.bak`); } catch { /* ok */ }
}

afterAll(() => {
  if (!NSC_AVAILABLE) return;
  cleanupTestBot();
});

describe("nats commands", () => {
  describe("detectAccount", () => {
    test.skipIf(!NSC_AVAILABLE)("detects current account from nsc config", () => {
      const account = detectAccount();
      expect(typeof account).toBe("string");
      expect(account.length).toBeGreaterThan(0);
    });
  });

  describe("addBot + removeBot lifecycle", () => {
    test.skipIf(!NSC_AVAILABLE)("creates user, writes creds with correct perms, removes cleanly", () => {
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
    test.skipIf(!NSC_AVAILABLE)("rejects subjects with shell metacharacters via CLI", () => {
      const result = Bun.spawnSync(["bun", "src/cli.ts", "nats", "add-bot", "subj-test",
        "-a", TEST_ACCOUNT, "--pub", "valid.subject,$(evil)",
      ], { cwd: join(import.meta.dir, "../.."), stderr: "pipe" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Invalid NATS subject");
    });

    test.skipIf(!NSC_AVAILABLE)("rejects invalid bot name via CLI", () => {
      const result = Bun.spawnSync(["bun", "src/cli.ts", "nats", "add-bot", "UPPER-CASE",
        "-a", TEST_ACCOUNT,
      ], { cwd: join(import.meta.dir, "../.."), stderr: "pipe" });

      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("creds directory permissions", () => {
    test.skipIf(!NSC_AVAILABLE)("creds directory is mode 700", () => {
      const dir = join(homedir(), ".config", "nats");
      if (existsSync(dir)) {
        const stat = statSync(dir);
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });
  });
});
