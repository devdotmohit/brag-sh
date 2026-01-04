import { readConfig, writeConfig } from "../lib/config";
import {
  disableSchedule,
  enableSchedule,
  getSchedulePreview,
  getScheduleStatus,
} from "../lib/schedule";

function printHelp(): void {
  console.log("brag schedule");
  console.log("");
  console.log("Usage:");
  console.log("  brag schedule status");
  console.log("  brag schedule enable");
  console.log("  brag schedule disable");
  console.log("  brag schedule print");
  console.log("");
  console.log("Notes:");
  console.log("  Enabling sets syncMode=background; disabling sets syncMode=manual.");
}

function updateSyncMode(value: "background" | "manual"): string | null {
  try {
    const { config } = readConfig();
    config.syncMode = value;
    writeConfig(config);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function schedule(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return 0;
  }

  const subcommand = args[0] ?? "status";

  if (subcommand === "status") {
    const status = getScheduleStatus();
    console.log("Schedule status");
    console.log("");
    console.log(`Platform: ${status.platform}`);
    console.log(`Installed: ${status.installed ? "yes" : "no"}`);
    if (status.method) {
      console.log(`Method: ${status.method}`);
    }
    if (status.details) {
      console.log(`Details: ${status.details}`);
    }
    return status.installed ? 0 : 1;
  }

  if (subcommand === "print") {
    const preview = getSchedulePreview();
    console.log("Schedule preview");
    console.log("");
    console.log(`Platform: ${preview.platform}`);
    if (preview.method) {
      console.log(`Method: ${preview.method}`);
    }
    console.log("");
    console.log("Command:");
    console.log(`  ${preview.command.exe} ${preview.command.args.join(" ")}`);
    console.log(`  Working dir: ${preview.command.workingDir}`);
    if (preview.files.length > 0) {
      console.log("");
      console.log("Files:");
      for (const file of preview.files) {
        console.log(`- ${file.path}`);
      }
    }
    if (preview.notes.length > 0) {
      console.log("");
      console.log("Notes:");
      for (const note of preview.notes) {
        console.log(`- ${note}`);
      }
    }
    return 0;
  }

  if (subcommand === "enable") {
    const result = enableSchedule();
    if (!result.ok) {
      console.error(result.message);
      for (const warning of result.warnings) {
        console.error(`- ${warning}`);
      }
      return 1;
    }
    const configError = updateSyncMode("background");
    console.log(result.message);
    if (configError) {
      console.error(`Failed to update syncMode: ${configError}`);
      return 1;
    }
    for (const warning of result.warnings) {
      console.warn(`- ${warning}`);
    }
    return 0;
  }

  if (subcommand === "disable") {
    const result = disableSchedule();
    if (!result.ok) {
      console.error(result.message);
      for (const warning of result.warnings) {
        console.error(`- ${warning}`);
      }
      return 1;
    }
    const configError = updateSyncMode("manual");
    console.log(result.message);
    if (configError) {
      console.error(`Failed to update syncMode: ${configError}`);
      return 1;
    }
    for (const warning of result.warnings) {
      console.warn(`- ${warning}`);
    }
    return 0;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  return 1;
}
