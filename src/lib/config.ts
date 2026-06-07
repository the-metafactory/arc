import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import YAML from "yaml";

export interface ArcUserConfig {
  binDir?: string;
}

interface RawArcUserConfig {
  bin_dir?: unknown;
  binDir?: unknown;
}

export function expandHomePath(path: string, home = homedir()): string {
  if (path === "~") return home;
  return path.replace(/^~(?=\/)/, home);
}

export function normalizeUserPath(path: string, home = homedir()): string {
  const expanded = expandHomePath(path, home);
  return expanded === "/" ? expanded : expanded.replace(/\/+$/, "");
}

export function userConfigPath(configRoot: string): string {
  return join(configRoot, "config.yaml");
}

function normalizeConfig(raw: RawArcUserConfig | null | undefined, home = homedir()): ArcUserConfig {
  const rawBinDir = raw?.bin_dir ?? raw?.binDir;
  return {
    ...(typeof rawBinDir === "string" && rawBinDir.trim()
      ? { binDir: normalizeUserPath(rawBinDir.trim(), home) }
      : {}),
  };
}

export function loadUserConfigSync(configRoot: string, home = homedir()): ArcUserConfig {
  const path = userConfigPath(configRoot);
  if (!existsSync(path)) return {};

  try {
    const parsed = YAML.parse(readFileSync(path, "utf-8")) as RawArcUserConfig | null;
    return normalizeConfig(parsed, home);
  } catch {
    return {};
  }
}

export async function loadUserConfig(configRoot: string, home = homedir()): Promise<ArcUserConfig> {
  const path = userConfigPath(configRoot);
  if (!existsSync(path)) return {};

  try {
    const parsed = YAML.parse(await readFile(path, "utf-8")) as RawArcUserConfig | null;
    return normalizeConfig(parsed, home);
  } catch {
    return {};
  }
}

export async function saveUserConfig(configRoot: string, config: ArcUserConfig): Promise<void> {
  const path = userConfigPath(configRoot);
  const content = YAML.stringify(
    {
      ...(config.binDir ? { bin_dir: normalizeUserPath(config.binDir) } : {}),
    },
    { indent: 2 },
  );

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}
