import { describe, test, expect, afterAll } from "bun:test";
import { detectAccount, addBot, removeBot } from "../../src/commands/nats.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NSC_AVAILABLE = spawnSync("which", ["nsc"], { encoding: "utf-8" }).status === 0;
const TEST_ACCOUNT = "OP_JC";
const TEST_BOT = "arc-test-bot";
const CREDS_PATH = join(homedir(), ".config", "nats", `${TEST_BOT}.creds`);

// Cleanup in case prior run left state — use spawnSync to avoid process.exit
function cleanupTestBot(): void {
  spawnSync("nsc", ["delete", "user", "-a", TEST_ACCOUNT, "-n", TEST_BOT], { encoding: "utf-8" });
  const p = join(homedir(), ".config", "nats", `${TEST_BOT}.creds`);
  try { require("fs").unlinkSync(p); } catch { /* ok */ }
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
      const result = spawnSync("bun", [
        "src/cli.ts", "nats", "add-bot", "subj-test",
        "-a", TEST_ACCOUNT,
        "--pub", "valid.subject,$(evil)",
      ], { encoding: "utf-8", cwd: join(import.meta.dir, "../..") });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid NATS subject");
    });

    test.skipIf(!NSC_AVAILABLE)("rejects invalid bot name via CLI", () => {
      const result = spawnSync("bun", [
        "src/cli.ts", "nats", "add-bot", "UPPER-CASE",
        "-a", TEST_ACCOUNT,
      ], { encoding: "utf-8", cwd: join(import.meta.dir, "../..") });

      expect(result.status).not.toBe(0);
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
