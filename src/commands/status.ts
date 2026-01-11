import { join } from "node:path";

import { getAuthStatus, listAuthProfiles } from "../lib/auth";
import { getConfigDir, getConfigFilePath, readConfig } from "../lib/config";
import { isDebugEnabled } from "../lib/diagnostics";
import { readQueue } from "../lib/queue";
import { getNextAllowedAt } from "../lib/scheduler";
import { readSyncState } from "../lib/state";
import { discoverUsageSources } from "../lib/usage";

type StatusIssue = {
  code: string;
  message: string;
  hint?: string;
  severity: "error" | "warn";
};

function printIssue(issue: StatusIssue): void {
  const hint = issue.hint ? ` Hint: ${issue.hint}` : "";
  console.log(`- [${issue.code}] ${issue.message}${hint}`);
}

function reportFatal(
  useJson: boolean,
  issue: StatusIssue
): number {
  if (useJson) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          issues: [issue],
        },
        null,
        2
      )
    );
    return 1;
  }
  console.error(issue.message);
  console.error(`Code: ${issue.code}`);
  if (issue.hint) {
    console.error(`Hint: ${issue.hint}`);
  }
  return 1;
}

export async function status(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log("brag status");
    console.log("");
    console.log("Usage:");
    console.log("  brag status [--json] [--debug]");
    console.log("");
    console.log("Options:");
    console.log("  --json  Print status as JSON");
    console.log("  --debug Enable verbose, redacted diagnostics");
    return 0;
  }

  const useJson = args.includes("--json");
  const issues: StatusIssue[] = [];
  let config;
  try {
    ({ config } = readConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reportFatal(useJson, {
      code: "STATUS_CONFIG_READ_FAILED",
      message,
      hint: "Check the config JSON and try again.",
      severity: "error",
    });
  }

  const discovery = discoverUsageSources(config);
  let syncState;
  try {
    syncState = readSyncState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reportFatal(useJson, {
      code: "STATUS_STATE_READ_FAILED",
      message,
      hint: "Fix or remove the sync state JSON to regenerate it.",
      severity: "error",
    });
  }

  const nextAllowedAt = getNextAllowedAt(syncState.lastSuccessAt)?.toISOString();
  const cachedTotals = syncState.dailyTotals ?? {};
  const cachedKeys = Object.keys(cachedTotals);
  const cachedDays = new Set(cachedKeys.map((key) => key.split("::")[0]));
  const cachedModels = new Set(cachedKeys.map((key) => key.split("::")[1]));
  let queueLength = 0;
  let queueError: string | undefined;
  try {
    queueLength = readQueue().length;
  } catch (error) {
    queueError = error instanceof Error ? error.message : String(error);
  }
  const auth = getAuthStatus();
  let profiles: ReturnType<typeof listAuthProfiles> = [];
  try {
    profiles = listAuthProfiles();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reportFatal(useJson, {
      code: "STATUS_PROFILE_READ_FAILED",
      message,
      hint: "Check the auth store for corruption.",
      severity: "error",
    });
  }

  if (syncState.lastStatus === "error") {
    if (syncState.lastErrorContext) {
      issues.push({
        code: syncState.lastErrorContext.code,
        message: syncState.lastErrorContext.message,
        hint: syncState.lastErrorContext.hint,
        severity: "warn",
      });
    } else if (syncState.lastError) {
      issues.push({
        code: "STATUS_LAST_SYNC_ERROR",
        message: syncState.lastError,
        hint: "Run `brag sync` to retry.",
        severity: "warn",
      });
    }
  }

  if (auth.status !== "valid") {
    const code =
      auth.status === "missing"
        ? "STATUS_AUTH_MISSING"
        : auth.status === "expired"
          ? "STATUS_AUTH_EXPIRED"
          : "STATUS_AUTH_REFRESH_FAILED";
    issues.push({
      code,
      message: auth.message ?? "Auth needs attention.",
      hint: "Run `brag login` to refresh credentials.",
      severity: "warn",
    });
  }

  if (queueError) {
    issues.push({
      code: "STATUS_QUEUE_READ_FAILED",
      message: queueError,
      hint: `Fix or remove ${join(getConfigDir(), "queue.json")}.`,
      severity: "warn",
    });
  }

  if (discovery.sources.length === 0) {
    issues.push({
      code: "STATUS_USAGE_NOT_FOUND",
      message: "No usage files found.",
      hint: "Set usagePath with `brag config set usagePath <path>` or set CODEX_HOME.",
      severity: "error",
    });
  }

  if (useJson) {
    const exitCode =
      discovery.sources.length === 0 && discovery.warnings.length > 0 ? 1 : 0;
    const payload = {
      ok: exitCode === 0,
      issues,
      configPath: getConfigFilePath(),
      syncMode: config.syncMode ?? "unset",
      localOnly: config.localOnly ?? false,
      usagePath: config.usagePath ?? discovery.basePath,
      discovery: {
        basePath: discovery.basePath,
        warnings: discovery.warnings,
        sources: discovery.sources,
      },
      lastSync: {
        status: syncState.lastStatus ?? "unknown",
        lastRunAt: syncState.lastRunAt ?? null,
        lastSuccessAt: syncState.lastSuccessAt ?? null,
        lastError: syncState.lastError ?? null,
        lastNote: syncState.lastNote ?? null,
        lastRecordsParsed: syncState.lastRecordsParsed ?? null,
        lastAggregatedEntries: syncState.lastAggregatedEntries ?? null,
        lastTotalTokens: syncState.lastTotalTokens ?? null,
        lastWarningsCount: syncState.lastWarningsCount ?? null,
        lastErrorContext:
          syncState.lastStatus === "error" ? syncState.lastErrorContext ?? null : null,
        nextAllowedAt: nextAllowedAt ?? null,
      },
      auth: {
        status: auth.status,
        source: auth.source ?? null,
        activeProfileId: auth.profileId ?? null,
        activeProfileLabel: auth.profileLabel ?? null,
        expiresAt: auth.expiresAt ?? null,
        refreshable: auth.refreshable ?? null,
        lastError: auth.lastError ?? null,
        message: auth.message ?? null,
        profiles: {
          total: profiles.length,
        },
      },
      queue: {
        pending: queueLength,
        error: queueError ?? null,
      },
      cachedTotals: {
        days: cachedDays.size,
        models: cachedModels.size,
      },
      debug: isDebugEnabled()
        ? {
            configDir: getConfigDir(),
            statePath: join(getConfigDir(), "state.json"),
            queuePath: join(getConfigDir(), "queue.json"),
          }
        : null,
    };
    console.log(JSON.stringify(payload, null, 2));
    return exitCode;
  }

  console.log("Usage Leaderboard status");
  console.log("");
  console.log(`Config path: ${getConfigFilePath()}`);
  console.log(`Sync mode: ${config.syncMode ?? "unset"}`);
  console.log(`Local only: ${config.localOnly ? "true" : "false"}`);
  console.log(`Usage path: ${config.usagePath ?? discovery.basePath}`);
  console.log("");

  if (discovery.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of discovery.warnings) {
      console.log(`- ${warning}`);
    }
    console.log("");
  }

  if (syncState.lastRunAt) {
    console.log("Last sync:");
    console.log(`- Status: ${syncState.lastStatus ?? "unknown"}`);
    console.log(`- Ran at: ${syncState.lastRunAt}`);
    if (syncState.lastSuccessAt) {
      console.log(`- Last success: ${syncState.lastSuccessAt}`);
    }
    if (nextAllowedAt) {
      console.log(`- Next allowed: ${nextAllowedAt}`);
    }
    if (syncState.lastNote) {
      console.log(`- Note: ${syncState.lastNote}`);
    }
    if (syncState.lastError) {
      console.log(`- Error: ${syncState.lastError}`);
    }
    if (syncState.lastStatus === "error" && syncState.lastErrorContext?.code) {
      console.log(`- Error code: ${syncState.lastErrorContext.code}`);
    }
    if (syncState.lastStatus === "error" && syncState.lastErrorContext?.hint) {
      console.log(`- Hint: ${syncState.lastErrorContext.hint}`);
    }
    if (syncState.lastRecordsParsed !== undefined) {
      console.log(`- Records parsed: ${syncState.lastRecordsParsed}`);
    }
    if (syncState.lastAggregatedEntries !== undefined) {
      console.log(`- Aggregated entries: ${syncState.lastAggregatedEntries}`);
    }
    if (syncState.lastTotalTokens !== undefined) {
      console.log(`- Total tokens: ${syncState.lastTotalTokens}`);
    }
    if (syncState.lastWarningsCount !== undefined) {
      console.log(`- Warnings: ${syncState.lastWarningsCount}`);
    }
    console.log("");
  }

  if (cachedKeys.length > 0) {
    console.log("Cached totals:");
    console.log(`- Days tracked: ${cachedDays.size}`);
    console.log(`- Models tracked: ${cachedModels.size}`);
    console.log("");
  }

  console.log("Auth:");
  console.log(`- Status: ${auth.status}`);
  if (auth.profileLabel) {
    console.log(`- Active profile: ${auth.profileLabel} (${auth.profileId})`);
  }
  if (auth.expiresAt) {
    console.log(`- Expires at: ${auth.expiresAt}`);
  }
  if (auth.refreshable !== undefined) {
    console.log(`- Refreshable: ${auth.refreshable ? "yes" : "no"}`);
  }
  if (auth.source) {
    console.log(`- Source: ${auth.source}`);
  }
  if (profiles.length > 0) {
    console.log(`- Profiles: ${profiles.length}`);
  }
  if (auth.lastError) {
    console.log(`- Last error: ${auth.lastError.message} (${auth.lastError.at})`);
  }
  if (auth.message) {
    console.log(`- Note: ${auth.message}`);
  }
  console.log("");

  console.log("Queue:");
  console.log(`- Pending: ${queueLength}`);
  if (queueError) {
    console.log(`- Error: ${queueError}`);
  }
  console.log("");

  if (discovery.sources.length === 0) {
    console.log("Usage sources: none found");
  } else {
    console.log("Usage sources:");
    for (const source of discovery.sources) {
      console.log(`- ${source.kind}: ${source.path}`);
    }
  }

  if (issues.length > 0) {
    console.log("");
    console.log("Issues:");
    issues.forEach(printIssue);
  }

  if (isDebugEnabled()) {
    console.log("");
    console.log("Debug:");
    console.log(`- Config dir: ${getConfigDir()}`);
    console.log(`- State path: ${join(getConfigDir(), "state.json")}`);
    console.log(`- Queue path: ${join(getConfigDir(), "queue.json")}`);
  }

  return discovery.sources.length === 0 && discovery.warnings.length > 0 ? 1 : 0;
}
