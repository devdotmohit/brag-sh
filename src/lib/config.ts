import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SyncMode = "background" | "manual";

export type Config = {
  version: 1;
  syncMode?: SyncMode;
  usagePath?: string;
  apiBaseUrl?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthDeviceUrl?: string;
  oauthTokenUrl?: string;
  oauthScopes?: string;
  oauthAudience?: string;
  localOnly?: boolean;
  [key: string]: unknown;
};

const DEFAULT_CONFIG: Config = {
  version: 1,
  apiBaseUrl: "https://usageleaderboard.com",
};

const LOCAL_API_DEFAULT = "http://localhost:4321";

function resolveLocalApiBaseUrl(): string | undefined {
  const raw = process.env.BRAG_LOCAL_API;
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized || ["0", "false", "no", "off"].includes(normalized)) {
    return undefined;
  }
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return trimmed;
  }
  return LOCAL_API_DEFAULT;
}

export function resolveApiBaseUrl(config: Config): string | undefined {
  return resolveLocalApiBaseUrl() ?? config.apiBaseUrl ?? process.env.BRAG_API_BASE_URL;
}

function resolveConfigDir(): string {
  const home = homedir();

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "brag");
  }

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "brag");
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(xdgConfig, "brag");
}

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getConfigFilePath(): string {
  return join(resolveConfigDir(), "config.json");
}

export function readConfig(): { config: Config; exists: boolean } {
  const configPath = getConfigFilePath();
  if (!existsSync(configPath)) {
    return { config: { ...DEFAULT_CONFIG }, exists: false };
  }

  const raw = readFileSync(configPath, "utf8");
  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch {
    throw new Error(`Invalid config JSON at ${configPath}.`);
  }
  return { config: { ...DEFAULT_CONFIG, ...parsed, version: 1 }, exists: true };
}

export function writeConfig(config: Config): void {
  const configPath = getConfigFilePath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ ...config, version: 1 }, null, 2);
  writeFileSync(configPath, `${payload}\n`, { mode: 0o600 });
}
