import { clearAuth, listAuthProfiles, removeAuthProfile } from "../lib/auth";
import { logEvent } from "../lib/logger";

function parseArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function printHelp(): void {
  console.log("brag logout");
  console.log("");
  console.log("Usage:");
  console.log("  brag logout");
  console.log("  brag logout --profile <id>");
  console.log("  brag logout --all");
}

export async function logout(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return 0;
  }

  if (args.includes("--all")) {
    const cleared = clearAuth();
    logEvent("info", "auth.logout.all", { cleared });
    console.log(cleared ? "Cleared all stored credentials." : "No stored credentials found.");
    return 0;
  }

  const profileId = parseArgValue(args, "--profile");
  if (profileId) {
    const result = removeAuthProfile(profileId);
    if (!result.removed) {
      console.log(`No stored profile named ${profileId}.`);
      return 0;
    }
    logEvent("info", "auth.logout.profile", { profileId });
    console.log(`Cleared credentials for profile ${profileId}.`);
    return 0;
  }

  let profiles;
  try {
    profiles = listAuthProfiles();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const active = profiles.find((profile) => profile.isActive)?.id;
  if (!active) {
    console.log("No stored credentials found.");
    return 0;
  }
  removeAuthProfile(active);
  logEvent("info", "auth.logout.active", { profileId: active });
  console.log("Cleared stored credentials.");
  return 0;
}
