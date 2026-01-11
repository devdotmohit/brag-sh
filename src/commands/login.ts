import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import { listAuthProfiles, setActiveProfile, upsertAuthProfile } from "../lib/auth";
import type { AuthToken } from "../lib/auth-types";
import { readConfig, writeConfig } from "../lib/config";
import { printDisclosure } from "../lib/disclosure";
import { pollDeviceToken, requestDeviceCode, resolveOAuthConfig } from "../lib/oauth";
import { logEvent } from "../lib/logger";
import { disableSchedule, enableSchedule } from "../lib/schedule";
import { sync } from "./sync";

function parseArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printHelp(): void {
  console.log("brag login");
  console.log("");
  console.log("Usage:");
  console.log("  brag login");
  console.log("  brag login --token <token> [--token-type <type>]");
  console.log("  brag login --profile <name>");
  console.log("  brag login --switch <name>");
  console.log("  brag login --list");
  console.log("");
  console.log("Options:");
  console.log("  --token        API bearer token");
  console.log("  --token-type   Token type (default: Bearer)");
  console.log("  --profile      Profile label to store credentials under");
  console.log("  --switch       Switch active profile without logging in");
  console.log("  --list         List stored profiles");
  console.log("  --mode         Set sync mode (background|manual)");
  console.log("  --no-prompt    Skip sync mode prompt");
  console.log("  --open         Open verification URL in the browser");
  console.log("");
  console.log("Notes:");
  console.log("  - Set apiBaseUrl (or BRAG_API_BASE_URL) to use browser login via /device.");
  console.log("");
  printDisclosure();
}

function formatProfiles(): string[] {
  const profiles = listAuthProfiles();
  if (profiles.length === 0) {
    return ["No profiles stored."];
  }
  return profiles.map((profile) => {
    const active = profile.isActive ? " (active)" : "";
    const expiresAt = profile.expiresAt ? ` expires ${profile.expiresAt}` : "";
    return `- ${profile.label} [${profile.id}]${active}${expiresAt}`;
  });
}

function openBrowser(url: string): void {
  if (!url) {
    return;
  }
  if (process.platform === "darwin") {
    spawnSync("open", [url], { stdio: "ignore" });
  } else if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  } else {
    spawnSync("xdg-open", [url], { stdio: "ignore" });
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function applySyncMode(mode: "background" | "manual"): Promise<boolean> {
  try {
    const { config } = readConfig();
    if (mode === "background") {
      const result = enableSchedule();
      if (!result.ok) {
        console.error(result.message);
        for (const warning of result.warnings) {
          console.error(`- ${warning}`);
        }
        return false;
      }
      for (const warning of result.warnings) {
        console.warn(`- ${warning}`);
      }
      config.syncMode = "background";
      writeConfig(config);
      console.log(result.message);
      return true;
    }

    const result = disableSchedule();
    if (!result.ok) {
      console.error(result.message);
      for (const warning of result.warnings) {
        console.error(`- ${warning}`);
      }
      return false;
    }
    config.syncMode = "manual";
    writeConfig(config);
    console.log(result.message);
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function maybePromptSyncMode(args: string[]): Promise<void> {
  if (hasFlag(args, "--no-prompt") || process.env.BRAG_NO_PROMPT) {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  let config;
  try {
    ({ config } = readConfig());
  } catch {
    return;
  }

  const modeArg = parseArgValue(args, "--mode");
  if (modeArg === "background" || modeArg === "manual") {
    await applySyncMode(modeArg);
    return;
  }

  if (config.syncMode) {
    return;
  }

  console.log("");
  console.log("Enable background sync every 15 minutes?");
  const answer = await prompt("Type y to enable, or press Enter for manual sync: ");
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") {
    await applySyncMode("background");
    return;
  }
  await applySyncMode("manual");
}

export async function login(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return 0;
  }

  if (hasFlag(args, "--list")) {
    try {
      console.log("Stored profiles:");
      for (const line of formatProfiles()) {
        console.log(line);
      }
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const switchProfile = parseArgValue(args, "--switch");
  if (switchProfile) {
    const result = setActiveProfile(switchProfile);
    if (!result.ok) {
      console.error(result.message ?? "Failed to switch profile.");
      return 1;
    }
    console.log(`Active profile set to ${switchProfile}.`);
    return 0;
  }

  const profileLabel = parseArgValue(args, "--profile");
  const token = parseArgValue(args, "--token") ?? process.env.BRAG_API_TOKEN;
  const tokenType = parseArgValue(args, "--token-type") ?? "Bearer";
  const open = hasFlag(args, "--open");

  let authToken: AuthToken;
  let flow: "token" | "device" = "device";

  if (token) {
    const createdAt = new Date().toISOString();
    flow = "token";
    authToken = {
      accessToken: token,
      tokenType,
      createdAt,
    };
  } else {
    let config;
    try {
      ({ config } = readConfig());
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const oauth = resolveOAuthConfig(config);
    if (!oauth.ok) {
      console.error(oauth.error);
      console.error("Set OAuth settings via config or BRAG_OAUTH_* env vars.");
      return 1;
    }

    let device;
    try {
      device = await requestDeviceCode(oauth.config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
    const canPrompt = process.stdin.isTTY && process.stdout.isTTY;

    console.log("Complete OAuth in your browser:");
    console.log(`- Verification URL: ${device.verificationUri}`);
    if (device.verificationUriComplete) {
      console.log(`- Direct URL: ${device.verificationUriComplete}`);
    }
    console.log(`- User code: ${device.userCode}`);

    if (open) {
      openBrowser(verificationUrl);
    } else if (canPrompt) {
      const answer = await prompt("Press Enter to open the verification URL in your browser: ");
      if (!answer.trim()) {
        openBrowser(verificationUrl);
      }
    }
    console.log("");
    console.log("Waiting for authorization...");

    let tokenResponse;
    try {
      tokenResponse = await pollDeviceToken(oauth.config, device);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    const createdAt = new Date().toISOString();
    const expiresAt =
      tokenResponse.expiresIn !== undefined
        ? new Date(Date.now() + tokenResponse.expiresIn * 1000).toISOString()
        : undefined;

    authToken = {
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      tokenType: tokenResponse.tokenType ?? "Bearer",
      scope: tokenResponse.scope,
      createdAt,
      expiresAt,
    };
  }

  const profile = upsertAuthProfile({
    profileId: profileLabel,
    label: profileLabel,
    token: authToken,
  });

  logEvent("info", "auth.login.success", {
    flow,
    profileId: profile.id,
    label: profile.label,
    refreshable: Boolean(profile.token.refreshToken),
    expiresAt: profile.token.expiresAt,
  });

  console.log(`Stored credentials for profile ${profile.label}.`);
  await maybePromptSyncMode(args);
  console.log("");
  console.log("Running initial sync...");
  await sync([]);
  console.log("");
  printDisclosure();
  return 0;
}
