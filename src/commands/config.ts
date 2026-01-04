import { getConfigFilePath, readConfig, writeConfig } from "../lib/config";

const VALID_KEYS = [
  "syncMode",
  "usagePath",
  "apiBaseUrl",
  "oauthClientId",
  "oauthClientSecret",
  "oauthDeviceUrl",
  "oauthTokenUrl",
  "oauthScopes",
  "oauthAudience",
  "localOnly",
] as const;
type ConfigKey = (typeof VALID_KEYS)[number];
type ConfigValue = string | boolean;

function printHelp(): void {
  console.log("brag config");
  console.log("");
  console.log("Usage:");
  console.log("  brag config");
  console.log("  brag config path");
  console.log("  brag config get <key>");
  console.log("  brag config set <key> <value>");
  console.log("  brag config unset <key>");
  console.log("");
  console.log("Keys:");
  console.log(`  ${VALID_KEYS.join(", ")}`);
}

function isValidKey(key: string): key is ConfigKey {
  return (VALID_KEYS as readonly string[]).includes(key);
}

function parseBoolean(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("localOnly must be true or false.");
}

function parseValue(key: ConfigKey, raw: string): ConfigValue {
  if (key === "syncMode") {
    if (raw !== "background" && raw !== "manual") {
      throw new Error("syncMode must be 'background' or 'manual'.");
    }
  }

  if (key === "localOnly") {
    return parseBoolean(raw);
  }

  if (!raw.trim()) {
    throw new Error("Value cannot be empty.");
  }

  return raw;
}

function safeReadConfig(): ReturnType<typeof readConfig> | null {
  try {
    return readConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function config(args: string[]): Promise<number> {
  const [subcommand, key] = args;

  if (!subcommand || subcommand === "list") {
    const result = safeReadConfig();
    if (!result) {
      return 1;
    }
    const { config } = result;
    console.log(`Config path: ${getConfigFilePath()}`);
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    return 0;
  }

  if (subcommand === "path") {
    console.log(getConfigFilePath());
    return 0;
  }

  if (!key || !isValidKey(key)) {
    console.error("Unknown or missing key.");
    printHelp();
    return 1;
  }

  if (subcommand === "get") {
    const result = safeReadConfig();
    if (!result) {
      return 1;
    }
    const { config } = result;
    const value = config[key];
    if (value === undefined) {
      console.error(`No value set for ${key}.`);
      return 1;
    }
    console.log(String(value));
    return 0;
  }

  if (subcommand === "set") {
    const rawValue = args.slice(2).join(" ");
    if (!rawValue) {
      console.error("Missing value.");
      return 1;
    }

    try {
      const value = parseValue(key, rawValue);
      const result = safeReadConfig();
      if (!result) {
        return 1;
      }
      const { config } = result;
      config[key] = value;
      writeConfig(config);
      console.log(`Set ${key}.`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (subcommand === "unset") {
    const result = safeReadConfig();
    if (!result) {
      return 1;
    }
    const { config, exists } = result;
    if (!exists || config[key] === undefined) {
      console.error(`No value set for ${key}.`);
      return 1;
    }
    delete config[key];
    writeConfig(config);
    console.log(`Cleared ${key}.`);
    return 0;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  return 1;
}
