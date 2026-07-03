import type { ArcManifest } from "../../src/types.js";

export function createSkillManifest(name: string, trigger: string): ArcManifest {
  return {
    name,
    version: "1.0.0",
    type: "skill",
    tier: "custom",
    provides: {
      skill: [{ trigger }],
    },
    capabilities: {
      filesystem: { read: [], write: [] },
      network: [],
      bash: { allowed: false },
      secrets: [],
    },
  };
}
