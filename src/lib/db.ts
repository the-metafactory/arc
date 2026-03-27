import { Database } from "bun:sqlite";
import type {
  InstalledSkill,
  CapabilityRecord,
  PaiManifest,
} from "../types.js";

/**
 * Initialize (or open) the packages database.
 * Creates tables if they don't exist.
 */
export function openDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      install_path TEXT NOT NULL,
      skill_dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      artifact_type TEXT NOT NULL DEFAULT 'skill',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration: add artifact_type column to existing databases
  try {
    db.exec(`ALTER TABLE skills ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'skill'`);
  } catch {
    // Column already exists — expected for new or already-migrated databases
  }

  // Migration: add tier and customization_path columns
  try {
    db.exec(`ALTER TABLE skills ADD COLUMN tier TEXT NOT NULL DEFAULT 'custom'`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE skills ADD COLUMN customization_path TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE skills ADD COLUMN install_source TEXT`);
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (skill_name) REFERENCES skills(name) ON DELETE CASCADE
    );
  `);

  return db;
}

/**
 * Record an installed skill in the database.
 */
export function recordInstall(
  db: Database,
  skill: InstalledSkill,
  manifest: PaiManifest
): void {
  const now = new Date().toISOString();

  const insertSkill = db.prepare(`
    INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, customization_path, install_source, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSkill.run(
    skill.name,
    skill.version,
    skill.repo_url,
    skill.install_path,
    skill.skill_dir,
    skill.status,
    skill.artifact_type || "skill",
    skill.tier || manifest.tier || "custom",
    skill.customization_path || null,
    skill.install_source || null,
    skill.installed_at || now,
    skill.updated_at || now
  );

  // Record capabilities
  const insertCap = db.prepare(`
    INSERT INTO capabilities (skill_name, type, value, reason)
    VALUES (?, ?, ?, ?)
  `);

  const caps = manifest.capabilities;
  if (!caps) return;

  if (caps.filesystem?.read) {
    for (const p of caps.filesystem.read) {
      insertCap.run(skill.name, "fs_read", p, "");
    }
  }
  if (caps.filesystem?.write) {
    for (const p of caps.filesystem.write) {
      insertCap.run(skill.name, "fs_write", p, "");
    }
  }
  if (caps.network) {
    for (const n of caps.network) {
      insertCap.run(skill.name, "network", n.domain, n.reason);
    }
  }
  if (caps.bash?.restricted_to) {
    for (const b of caps.bash.restricted_to) {
      insertCap.run(skill.name, "bash", b, "");
    }
  }
  if (caps.secrets) {
    for (const s of caps.secrets) {
      insertCap.run(skill.name, "secret", s, "");
    }
  }
}

/**
 * Get all installed skills.
 */
export function listSkills(db: Database): InstalledSkill[] {
  return db
    .prepare("SELECT * FROM skills ORDER BY name")
    .all() as InstalledSkill[];
}

/**
 * Get a specific skill by name.
 */
export function getSkill(
  db: Database,
  name: string
): InstalledSkill | null {
  return (
    (db
      .prepare("SELECT * FROM skills WHERE name = ?")
      .get(name) as InstalledSkill) ?? null
  );
}

/**
 * Update skill status (active/disabled).
 */
export function updateSkillStatus(
  db: Database,
  name: string,
  status: "active" | "disabled"
): void {
  db.prepare(
    "UPDATE skills SET status = ?, updated_at = ? WHERE name = ?"
  ).run(status, new Date().toISOString(), name);
}

/**
 * Remove a skill and its capabilities from the database.
 */
export function removeSkill(db: Database, name: string): void {
  db.prepare("DELETE FROM skills WHERE name = ?").run(name);
}

/**
 * Get all capabilities for a specific skill.
 */
export function getCapabilities(
  db: Database,
  skillName: string
): CapabilityRecord[] {
  return db
    .prepare("SELECT * FROM capabilities WHERE skill_name = ?")
    .all(skillName) as CapabilityRecord[];
}

/**
 * Get all capabilities across all active skills (for audit).
 */
export function getAllActiveCapabilities(
  db: Database
): CapabilityRecord[] {
  return db
    .prepare(
      `SELECT c.* FROM capabilities c
       JOIN skills s ON c.skill_name = s.name
       WHERE s.status = 'active'
       ORDER BY c.type, c.skill_name`
    )
    .all() as CapabilityRecord[];
}
