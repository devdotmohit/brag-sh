import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getConfigDir } from "./config";

const SYNC_INTERVAL_MINUTES = 15;
const LAUNCHD_LABEL = "com.brag.sync";
const SYSTEMD_SERVICE = "brag-sync.service";
const SYSTEMD_TIMER = "brag-sync.timer";
const WINDOWS_TASK = "Brag Sync";

type SchedulePlatform = "darwin" | "linux" | "win32" | "unknown";
type ScheduleMethod = "launchd" | "systemd" | "schtasks";

export type ScheduleCommand = {
  exe: string;
  args: string[];
  workingDir: string;
};

export type ScheduleStatus = {
  platform: SchedulePlatform;
  method?: ScheduleMethod;
  installed: boolean;
  details?: string;
};

export type SchedulePreview = {
  platform: SchedulePlatform;
  method?: ScheduleMethod;
  command: ScheduleCommand;
  files: { path: string; contents: string }[];
  notes: string[];
};

export type ScheduleResult = {
  ok: boolean;
  message: string;
  warnings: string[];
};

type CommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

function detectPlatform(): SchedulePlatform {
  if (process.platform === "darwin") {
    return "darwin";
  }
  if (process.platform === "win32") {
    return "win32";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  return "unknown";
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : undefined,
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function resolveScheduleCommand(): ScheduleCommand {
  const exe = process.env.BRAG_SCHEDULER_NODE ?? process.execPath;
  const entry = process.env.BRAG_SCHEDULER_ENTRY ?? process.argv[1];
  if (!entry) {
    throw new Error("Unable to determine the CLI entry path.");
  }
  const entryPath = resolve(entry);
  const workingDir = getConfigDir();
  return {
    exe,
    args: [entryPath, "sync", "--quiet"],
    workingDir,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeSystemdArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function getLaunchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function buildLaunchdPlist(command: ScheduleCommand): string {
  const argsXml = [command.exe, ...command.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartInterval</key>
    <integer>${SYNC_INTERVAL_MINUTES * 60}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${escapeXml(command.workingDir)}</string>
  </dict>
</plist>
`;
}

function buildSystemdService(command: ScheduleCommand): string {
  const execLine = [command.exe, ...command.args]
    .map((arg) => escapeSystemdArg(arg))
    .join(" ");
  return `[Unit]
Description=Brag usage sync
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${command.workingDir}
ExecStart=${execLine}
`;
}

function buildSystemdTimer(): string {
  return `[Unit]
Description=Run Brag usage sync every ${SYNC_INTERVAL_MINUTES} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${SYNC_INTERVAL_MINUTES}min
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function getSystemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function getSystemdPaths(): { service: string; timer: string } {
  const dir = getSystemdDir();
  return {
    service: join(dir, SYSTEMD_SERVICE),
    timer: join(dir, SYSTEMD_TIMER),
  };
}

function getWindowsCommandLine(command: ScheduleCommand): { exe: string; args: string } {
  const args = command.args.map((arg) => quoteWindowsArg(arg)).join(" ");
  return {
    exe: command.exe,
    args,
  };
}

function getWindowsTaskXmlPath(): string {
  return join(getConfigDir(), "brag-sync-task.xml");
}

function formatWindowsDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function escapeWindowsXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildWindowsTaskXml(command: ScheduleCommand): string {
  const { exe, args } = getWindowsCommandLine(command);
  const startBoundary = formatWindowsDate(new Date(Date.now() + 60_000));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>brag</Author>
    <Description>Sync Brag usage every ${SYNC_INTERVAL_MINUTES} minutes.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${SYNC_INTERVAL_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeWindowsXml(exe)}</Command>
      <Arguments>${escapeWindowsXml(args)}</Arguments>
      <WorkingDirectory>${escapeWindowsXml(command.workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function previewSchedule(): SchedulePreview {
  const platform = detectPlatform();
  const command = resolveScheduleCommand();
  const notes: string[] = [];
  const files: { path: string; contents: string }[] = [];
  let method: ScheduleMethod | undefined;

  if (platform === "darwin") {
    method = "launchd";
    files.push({ path: getLaunchdPath(), contents: buildLaunchdPlist(command) });
  } else if (platform === "linux") {
    method = "systemd";
    const paths = getSystemdPaths();
    files.push({ path: paths.service, contents: buildSystemdService(command) });
    files.push({ path: paths.timer, contents: buildSystemdTimer() });
  } else if (platform === "win32") {
    method = "schtasks";
    files.push({ path: getWindowsTaskXmlPath(), contents: buildWindowsTaskXml(command) });
  } else {
    notes.push("Unsupported platform for background scheduling.");
  }

  return { platform, method, command, files, notes };
}

export function getSchedulePreview(): SchedulePreview {
  return previewSchedule();
}

export function getScheduleStatus(): ScheduleStatus {
  const platform = detectPlatform();
  if (platform === "darwin") {
    const path = getLaunchdPath();
    return {
      platform,
      method: "launchd",
      installed: existsSync(path),
      details: path,
    };
  }
  if (platform === "linux") {
    const { service, timer } = getSystemdPaths();
    const installed = existsSync(service) && existsSync(timer);
    return {
      platform,
      method: "systemd",
      installed,
      details: installed ? `${service}, ${timer}` : service,
    };
  }
  if (platform === "win32") {
    const query = runCommand("schtasks", ["/Query", "/TN", WINDOWS_TASK]);
    return {
      platform,
      method: "schtasks",
      installed: query.ok,
      details: query.ok ? WINDOWS_TASK : query.stderr.trim() || query.error,
    };
  }

  return { platform, installed: false, details: "Unsupported platform." };
}

export function enableSchedule(): ScheduleResult {
  const preview = previewSchedule();
  const warnings: string[] = [...preview.notes];

  if (preview.platform === "unknown") {
    return {
      ok: false,
      message: "Unsupported platform for background scheduling.",
      warnings,
    };
  }

  if (preview.platform === "darwin") {
    const path = getLaunchdPath();
    ensureDir(dirname(path));
    writeFileSync(path, preview.files[0]?.contents ?? "", { mode: 0o644 });
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const domain = uid !== null ? `gui/${uid}` : "gui";
    const bootout = runCommand("launchctl", ["bootout", domain, path]);
    if (!bootout.ok && bootout.error) {
      warnings.push(`launchctl bootout warning: ${bootout.error}`);
    }
    const bootstrap = runCommand("launchctl", ["bootstrap", domain, path]);
    if (!bootstrap.ok) {
      return {
        ok: false,
        message: "Failed to load launchd job.",
        warnings: [
          ...warnings,
          bootstrap.stderr.trim() || bootstrap.error || "launchctl bootstrap failed.",
        ],
      };
    }
    const target = uid !== null ? `${domain}/${LAUNCHD_LABEL}` : LAUNCHD_LABEL;
    const enable = runCommand("launchctl", ["enable", target]);
    if (!enable.ok && enable.error) {
      warnings.push(`launchctl enable warning: ${enable.error}`);
    }
    runCommand("launchctl", ["kickstart", "-k", target]);
    return { ok: true, message: "Launchd schedule enabled.", warnings };
  }

  if (preview.platform === "linux") {
    const paths = getSystemdPaths();
    ensureDir(dirname(paths.service));
    for (const file of preview.files) {
      writeFileSync(file.path, file.contents, { mode: 0o644 });
    }
    const reload = runCommand("systemctl", ["--user", "daemon-reload"]);
    if (!reload.ok) {
      return {
        ok: false,
        message: "Failed to reload systemd user daemon.",
        warnings: [
          ...warnings,
          reload.stderr.trim() || reload.error || "systemctl daemon-reload failed.",
        ],
      };
    }
    const enable = runCommand("systemctl", ["--user", "enable", "--now", SYSTEMD_TIMER]);
    if (!enable.ok) {
      return {
        ok: false,
        message: "Failed to enable systemd timer.",
        warnings: [
          ...warnings,
          enable.stderr.trim() || enable.error || "systemctl enable failed.",
        ],
      };
    }
    return { ok: true, message: "Systemd timer enabled.", warnings };
  }

  if (preview.platform === "win32") {
    const xmlPath = getWindowsTaskXmlPath();
    ensureDir(dirname(xmlPath));
    const xml = preview.files[0]?.contents ?? "";
    writeFileSync(xmlPath, xml, { encoding: "utf16le" });
    const result = runCommand("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/XML", xmlPath, "/F"]);
    if (!result.ok) {
      return {
        ok: false,
        message: "Failed to register scheduled task.",
        warnings: [
          ...warnings,
          result.stderr.trim() || result.error || "schtasks /Create failed.",
        ],
      };
    }
    return { ok: true, message: "Scheduled task enabled.", warnings };
  }

  return {
    ok: false,
    message: "Unsupported platform for background scheduling.",
    warnings,
  };
}

export function disableSchedule(): ScheduleResult {
  const platform = detectPlatform();
  const warnings: string[] = [];

  if (platform === "darwin") {
    const path = getLaunchdPath();
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const domain = uid !== null ? `gui/${uid}` : "gui";
    runCommand("launchctl", ["bootout", domain, path]);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
    return { ok: true, message: "Launchd schedule disabled.", warnings };
  }

  if (platform === "linux") {
    runCommand("systemctl", ["--user", "disable", "--now", SYSTEMD_TIMER]);
    const { service, timer } = getSystemdPaths();
    if (existsSync(service)) {
      rmSync(service, { force: true });
    }
    if (existsSync(timer)) {
      rmSync(timer, { force: true });
    }
    runCommand("systemctl", ["--user", "daemon-reload"]);
    return { ok: true, message: "Systemd timer disabled.", warnings };
  }

  if (platform === "win32") {
    const result = runCommand("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
    if (!result.ok) {
      return {
        ok: false,
        message: "Failed to delete scheduled task.",
        warnings: [result.stderr.trim() || result.error || "schtasks /Delete failed."],
      };
    }
    return { ok: true, message: "Scheduled task disabled.", warnings };
  }

  return {
    ok: false,
    message: "Unsupported platform for background scheduling.",
    warnings,
  };
}
