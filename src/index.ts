import { config } from "./commands/config";
import { login } from "./commands/login";
import { logout } from "./commands/logout";
import { schedule } from "./commands/schedule";
import { status } from "./commands/status";
import { sync } from "./commands/sync";
import { setDebug } from "./lib/diagnostics";
import { printDisclosure } from "./lib/disclosure";
import { readPackageVersion } from "./lib/version";

type CommandDefinition = {
  description: string;
  run: (args: string[]) => Promise<number> | number;
};

const COMMANDS: Record<string, CommandDefinition> = {
  login: {
    description: "Authenticate with GitHub and store a token",
    run: login,
  },
  status: {
    description: "Show auth state and last sync status",
    run: status,
  },
  sync: {
    description: "Trigger a manual sync of local usage",
    run: sync,
  },
  logout: {
    description: "Clear stored credentials",
    run: logout,
  },
  config: {
    description: "View or update local configuration",
    run: config,
  },
  schedule: {
    description: "Manage background sync scheduling",
    run: schedule,
  },
};

function printHelp(command?: string): void {
  if (command && COMMANDS[command]) {
    const { description } = COMMANDS[command];
    console.log(`brag ${command}`);
    console.log("");
    console.log(description);
    console.log("");
    console.log("Usage:");
    console.log(`  brag ${command}`);
    console.log("");
    printDisclosure();
    return;
  }

  console.log("brag");
  console.log("");
  console.log("Usage:");
  console.log("  brag <command>");
  console.log("");
  console.log("Commands:");
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${description}`);
  }
  console.log("");
  console.log("Options:");
  console.log("  -h, --help     Show help");
  console.log("  -v, --version  Show version");
  console.log("  --debug        Enable verbose, redacted diagnostics");
  console.log("");
  printDisclosure();
  console.log("");
  console.log("Run 'brag help <command>' for details on a command.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debugIndex = args.indexOf("--debug");
  if (debugIndex !== -1) {
    setDebug(true);
    args.splice(debugIndex, 1);
  }
  const command = args[0];

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "-v" || command === "--version") {
    console.log(readPackageVersion());
    return;
  }

  if (command === "help") {
    printHelp(args[1]);
    return;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const exitCode = await entry.run(args.slice(1));
  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exitCode = 1;
});
