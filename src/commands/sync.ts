import { postSyncPayloadWithRetry, resolveSyncUrl } from "../lib/api";
import { recordAuthError, resolveAuthToken } from "../lib/auth";
import { readConfig } from "../lib/config";
import { getOrCreateDeviceInfo } from "../lib/device";
import { buildErrorContext, debugLog } from "../lib/diagnostics";
import { buildSyncPayload } from "../lib/payload";
import { enqueuePayload, readQueue, updateQueue } from "../lib/queue";
import { computeNextRun, formatDuration, getRateLimitStatus } from "../lib/scheduler";
import { readSyncState, writeSyncState } from "../lib/state";
import { aggregateUsage } from "../lib/usage-aggregate";
import type { AggregatedUsage } from "../lib/usage-aggregate";
import { parseUsageSources } from "../lib/usage-parser";
import { applyCumulativeAdjustments, mergeAggregates } from "../lib/usage-state";
import { discoverUsageSources } from "../lib/usage";
import { logEvent } from "../lib/logger";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

type SyncOptions = {
  dump: boolean;
  dumpAll: boolean;
  payload: boolean;
  json: boolean;
  force: boolean;
  localOnly: boolean;
  quiet: boolean;
};

type SyncResult = {
  status: "success" | "error" | "skipped";
  message?: string;
  warnings: string[];
  recordsParsed: number;
  aggregatedDelta: number;
  aggregatedEntries?: AggregatedUsage[];
  totalTokens: number;
  days: number;
  models: number;
  payload?: ReturnType<typeof buildSyncPayload>;
  api?: {
    url?: string;
    status?: number;
    error?: string;
    attempts?: number;
  };
  rateLimit?: {
    limited: boolean;
    nextAllowedAt?: string;
  };
  queue?: {
    pending: number;
    flushed: number;
    enqueued: boolean;
  };
  auth?: {
    status: "missing" | "valid" | "expired" | "refresh_failed";
    source?: "env" | "store";
    profileId?: string;
    profileLabel?: string;
    expiresAt?: string;
    refreshable?: boolean;
    message?: string;
  };
  localOnly?: boolean;
};

function buildSummary(
  parsedCount: number,
  aggregatedCount: number,
  totalTokens: number,
  days: number,
  models: number
): SyncResult {
  return {
    status: "success",
    warnings: [],
    recordsParsed: parsedCount,
    aggregatedDelta: aggregatedCount,
    totalTokens,
    days,
    models,
  };
}

function logSyncResult(result: SyncResult): void {
  const level =
    result.status === "error" ? "error" : result.status === "skipped" ? "warn" : "info";
  logEvent(level, "sync.result", {
    status: result.status,
    message: result.message,
    recordsParsed: result.recordsParsed,
    aggregatedDelta: result.aggregatedDelta,
    warnings: result.warnings.length,
    localOnly: result.localOnly,
    rateLimited: result.rateLimit?.limited ?? false,
  });
}

function finalize(result: SyncResult): SyncResult {
  logSyncResult(result);
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hintForStatus(status?: number): string | undefined {
  if (status === 401 || status === 403) {
    return "Run `brag login` to refresh credentials.";
  }
  if (status === 404) {
    return "Check BRAG_API_BASE_URL for the correct endpoint.";
  }
  if (status === 429) {
    return "Wait before retrying to avoid rate limits.";
  }
  if (status && status >= 500) {
    return "Retry later or check server status.";
  }
  return undefined;
}

function isEnvLocalOnly(): boolean {
  const raw = process.env.BRAG_LOCAL_ONLY;
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function runSyncOnce(options: SyncOptions): Promise<SyncResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  logEvent("info", "sync.start", {
    localOnly: options.localOnly,
    force: options.force,
    dump: options.dump,
    payload: options.payload,
    json: options.json,
  });

  let syncState;
  try {
    syncState = readSyncState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog("sync.state.read_failed", { error: message });
    return finalize({
      status: "error",
      message,
      warnings: [],
      recordsParsed: 0,
      aggregatedDelta: 0,
      totalTokens: 0,
      days: 0,
      models: 0,
    });
  }
  let lastErrorContext = syncState.lastErrorContext;

  let config;
  try {
    ({ config } = readConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastErrorContext = buildErrorContext({
      code: "SYNC_CONFIG_READ_FAILED",
      message,
      hint: "Fix the config JSON and retry.",
      at: nowIso,
    });
    writeSyncState({
      ...syncState,
      lastRunAt: nowIso,
      lastStatus: "error",
      lastError: message,
      lastErrorContext,
    });
    return finalize({
      status: "error",
      message,
      warnings: [],
      recordsParsed: 0,
      aggregatedDelta: 0,
      totalTokens: 0,
      days: 0,
      models: 0,
    });
  }

  const discovery = discoverUsageSources(config);
  if (discovery.sources.length === 0) {
    const message = "No usage files found.";
    lastErrorContext = buildErrorContext({
      code: "SYNC_USAGE_NOT_FOUND",
      message,
      hint: "Set usagePath with `brag config set usagePath <path>` or set CODEX_HOME.",
      at: nowIso,
    });
    writeSyncState({
      ...syncState,
      lastRunAt: nowIso,
      lastStatus: "error",
      lastError: message,
      lastErrorContext,
      lastSourcesCount: discovery.sources.length,
      lastWarningsCount: discovery.warnings.length,
    });
    return finalize({
      status: "error",
      message,
      warnings: discovery.warnings,
      recordsParsed: 0,
      aggregatedDelta: 0,
      totalTokens: 0,
      days: 0,
      models: 0,
    });
  }

  const parsed = await parseUsageSources(discovery.sources, {
    cursors: syncState.fileCursors,
  });
  const adjusted = applyCumulativeAdjustments(
    parsed.records,
    syncState.cumulativeTotals ?? {}
  );
  const allWarnings = [...parsed.warnings, ...adjusted.warnings];

  const aggregatedDelta = aggregateUsage(adjusted.records);
  const nextDailyTotals = mergeAggregates(
    syncState.dailyTotals ?? {},
    aggregatedDelta
  );
  const totalTokens = Object.values(nextDailyTotals).reduce(
    (sum, entry) => sum + entry.total,
    0
  );
  const days = new Set(Object.keys(nextDailyTotals).map((key) => key.split("::")[0]));
  const models = new Set(Object.keys(nextDailyTotals).map((key) => key.split("::")[1]));
  const deviceInfo = getOrCreateDeviceInfo();
  const payload = buildSyncPayload(nextDailyTotals, {
    generatedAt: nowIso,
    deviceId: deviceInfo.deviceId,
    deviceName: deviceInfo.deviceName,
  });

  const summary = buildSummary(
    parsed.records.length,
    aggregatedDelta.length,
    totalTokens,
    days.size,
    models.size
  );
  summary.warnings = allWarnings;
  summary.payload = options.payload ? payload : undefined;
  summary.aggregatedEntries = options.dump ? aggregatedDelta : undefined;

  const localOnly = options.localOnly || config.localOnly === true || isEnvLocalOnly();
  summary.localOnly = localOnly;

  const rateLimit = getRateLimitStatus(syncState.lastSuccessAt, now.getTime());
  summary.rateLimit = rateLimit;

  const endpoint = resolveSyncUrl(config);
  let lastStatus: SyncResult["status"] = "success";
  let lastError: string | undefined;
  let lastNote: string | undefined;
  let lastSuccessAt = syncState.lastSuccessAt;
  let queue: ReturnType<typeof readQueue> = [];
  let flushedCount = 0;
  let pendingCount = 0;
  let enqueued = false;

  try {
    queue = readQueue();
    pendingCount = queue.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog("sync.queue.read_failed", { error: message });
    allWarnings.push(message);
  }

  const auth = await resolveAuthToken({ allowRefresh: true });
  summary.auth = {
    status: auth.status,
    source: auth.source,
    profileId: auth.profileId,
    profileLabel: auth.profileLabel,
    expiresAt: auth.expiresAt,
    refreshable: auth.refreshable,
    message: auth.message,
  };

  if (localOnly) {
    lastStatus = "skipped";
    lastNote = "Local-only mode enabled. No upload attempted.";
    summary.status = "skipped";
    summary.message = lastNote;
  } else if (!endpoint.url) {
    lastStatus = "skipped";
    lastNote = endpoint.error ?? "API base URL not configured.";
    summary.status = "skipped";
    summary.message = lastNote;
  } else if (auth.status !== "valid" || !auth.token) {
    lastStatus = "skipped";
    lastNote = auth.message ?? "Auth token missing or invalid.";
    summary.status = "skipped";
    summary.message = lastNote;
  } else if (rateLimit.limited && !options.force) {
    lastStatus = "skipped";
    lastNote = `Rate limited until ${rateLimit.nextAllowedAt ?? "later"}.`;
    summary.status = "skipped";
    summary.message = lastNote;
  } else {
    pendingCount = queue.length;
    if (queue.length > 0) {
      const remaining: typeof queue = [];
      for (const item of queue) {
        const response = await postSyncPayloadWithRetry(endpoint.url, item.payload, {
          token: auth.token,
          tokenType: auth.tokenType,
        });
        if (!response.ok) {
          let responseMessage = response.error ?? "Failed to flush queued payload.";
          if (response.status === 401 || response.status === 403) {
            if (auth.profileId) {
              recordAuthError(auth.profileId, "API rejected token.", String(response.status));
            }
            lastNote = "Auth rejected by API. Run brag login.";
            responseMessage = lastNote;
          }
          lastErrorContext = buildErrorContext({
            code: "SYNC_QUEUE_FLUSH_FAILED",
            message: responseMessage,
            hint: hintForStatus(response.status),
            status: response.status,
            url: response.url,
            at: nowIso,
          });
          debugLog("sync.queue.flush_failed", {
            status: response.status,
            error: response.error,
            attempts: response.attempts,
          });
          remaining.push({
            ...item,
            attempts: item.attempts + 1,
            lastAttemptAt: nowIso,
            lastError: response.error,
          });
          summary.api = {
            url: response.url,
            status: response.status,
            error: response.error,
            attempts: response.attempts,
          };
          lastStatus = "error";
          lastError = responseMessage;
          summary.status = "error";
          summary.message = responseMessage;
          break;
        }

        flushedCount += 1;
      }

      if (remaining.length > 0) {
        updateQueue(remaining);
        pendingCount = remaining.length;
      } else if (queue.length > 0) {
        updateQueue([]);
        pendingCount = 0;
      }

      if (lastStatus === "error") {
        summary.queue = {
          pending: pendingCount,
          flushed: flushedCount,
          enqueued,
        };
        writeSyncState({
          ...syncState,
          lastRunAt: nowIso,
          lastSuccessAt,
          lastStatus,
          lastError,
          lastErrorContext,
          lastNote,
          lastSourcesCount: discovery.sources.length,
          lastRecordsParsed: parsed.records.length,
          lastAggregatedEntries: aggregatedDelta.length,
          lastTotalTokens: totalTokens,
          lastWarningsCount: allWarnings.length,
          fileCursors: parsed.cursors,
          dailyTotals: nextDailyTotals,
          cumulativeTotals: adjusted.cumulative,
        });
        return finalize(summary);
      }
    }

    const response = await postSyncPayloadWithRetry(endpoint.url, payload, {
      token: auth.token,
      tokenType: auth.tokenType,
    });
    summary.api = {
      url: response.url,
      status: response.status,
      error: response.error,
      attempts: response.attempts,
    };
    if (!response.ok) {
      let responseMessage = response.error ?? "Sync failed.";
      debugLog("sync.api.error", {
        status: response.status,
        error: response.error,
        attempts: response.attempts,
      });
      if (response.status === 401 || response.status === 403) {
        if (auth.profileId) {
          recordAuthError(auth.profileId, "API rejected token.", String(response.status));
        }
        lastNote = "Auth rejected by API. Run brag login.";
        responseMessage = lastNote;
      }
      lastStatus = "error";
      lastError = responseMessage;
      lastErrorContext = buildErrorContext({
        code: "SYNC_API_ERROR",
        message: responseMessage,
        hint: hintForStatus(response.status),
        status: response.status,
        url: response.url,
        at: nowIso,
      });
      summary.status = "error";
      summary.message = responseMessage;
      try {
        const nextQueue = enqueuePayload(payload, responseMessage);
        pendingCount = nextQueue.length;
        enqueued = true;
      } catch (error) {
        allWarnings.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      lastStatus = "success";
      lastSuccessAt = nowIso;
      summary.status = "success";
      summary.message = "Sync completed.";
    }
  }

  summary.queue = {
    pending: pendingCount,
    flushed: flushedCount,
    enqueued,
  };

  writeSyncState({
    ...syncState,
    lastRunAt: nowIso,
    lastSuccessAt,
    lastStatus,
    lastError,
    lastErrorContext,
    lastNote,
    lastSourcesCount: discovery.sources.length,
    lastRecordsParsed: parsed.records.length,
    lastAggregatedEntries: aggregatedDelta.length,
    lastTotalTokens: totalTokens,
    lastWarningsCount: allWarnings.length,
    fileCursors: parsed.cursors,
    dailyTotals: nextDailyTotals,
    cumulativeTotals: adjusted.cumulative,
  });

  return finalize(summary);
}

async function runWatch(options: SyncOptions): Promise<number> {
  if (!options.quiet) {
    console.log("Starting sync loop. Press Ctrl+C to stop.");
  }
  while (true) {
    const result = await runSyncOnce(options);
    if (options.quiet) {
      if (result.status === "error") {
        console.error(result.message ?? "Sync failed.");
      }
    } else {
      if (result.status === "error") {
        console.error(result.message ?? "Sync failed.");
      } else if (result.message) {
        console.log(result.message);
      }
    }

    let base = new Date().toISOString();
    try {
      const syncState = readSyncState();
      base = syncState.lastSuccessAt ?? syncState.lastRunAt ?? base;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    const { delayMs, nextRunAt } = computeNextRun(base);
    if (!options.quiet) {
      console.log(`Next sync in ${formatDuration(delayMs)} (at ${nextRunAt}).`);
    }
    await sleep(delayMs);
  }
}

export async function sync(_args: string[]): Promise<number> {
  const args = _args ?? [];
  if (args.includes("-h") || args.includes("--help")) {
    console.log("brag sync");
    console.log("");
    console.log("Usage:");
    console.log("  brag sync [--dump] [--dump-all] [--payload] [--json]");
    console.log("  brag sync --watch");
    console.log("");
    console.log("Options:");
    console.log("  --dump      Print the first 20 aggregated entries");
    console.log("  --dump-all  Print all aggregated entries");
    console.log("  --payload   Print the full daily payload JSON");
    console.log("  --json      Print sync output as JSON");
    console.log("  --force     Bypass rate limit for network sync");
    console.log("  --local     Skip upload and run in local-only mode");
    console.log("  --quiet     Suppress output except errors");
    console.log("  --watch     Run sync every 15 minutes with jitter");
    return 0;
  }

  const dumpAll = args.includes("--dump-all");
  const dump = dumpAll || args.includes("--dump");
  const dumpPayload = args.includes("--payload");
  const useJson = args.includes("--json");
  const force = args.includes("--force");
  const watch = args.includes("--watch");
  const localOnly = args.includes("--local") || args.includes("--local-only");
  const quiet = args.includes("--quiet");

  if (watch && (dump || dumpPayload || useJson)) {
    console.error("Watch mode cannot be combined with dump/payload/json output.");
    return 1;
  }

  if (quiet && (dump || dumpPayload || useJson)) {
    console.error("Quiet mode cannot be combined with dump/payload/json output.");
    return 1;
  }

  const options: SyncOptions = {
    dump,
    dumpAll,
    payload: dumpPayload,
    json: useJson,
    force,
    localOnly,
    quiet,
  };

  if (watch) {
    return runWatch(options);
  }

  const result = await runSyncOnce(options);

  if (useJson) {
    const payload = {
      status: result.status,
      message: result.message ?? null,
      recordsParsed: result.recordsParsed,
      aggregatedDelta: result.aggregatedDelta,
      totalTokens: result.totalTokens,
      days: result.days,
      models: result.models,
      warnings: result.warnings,
      payload: result.payload ?? null,
      rateLimit: result.rateLimit ?? null,
      api: result.api ?? null,
      queue: result.queue ?? null,
      auth: result.auth ?? null,
      localOnly: result.localOnly ?? null,
    };
    console.log(JSON.stringify(payload, null, 2));
    return result.status === "error" ? 1 : 0;
  }

  if (quiet) {
    if (result.status === "error") {
      console.error(result.message ?? "Sync failed.");
    }
    return result.status === "error" ? 1 : 0;
  }

  console.log("Sync preview");
  console.log("");
  console.log(`Records parsed: ${formatNumber(result.recordsParsed)}`);
  console.log(`New aggregated entries: ${formatNumber(result.aggregatedDelta)}`);
  console.log(`Days: ${result.days}`);
  console.log(`Models: ${result.models}`);
  console.log(`Total tokens: ${formatNumber(result.totalTokens)}`);
  console.log("");

  if (result.warnings.length > 0) {
    console.log("Parse warnings:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
    console.log("");
  }

  if (result.recordsParsed === 0) {
    console.log("No new usage records found.");
  }

  if (dump) {
    const entries = result.aggregatedEntries ?? [];
    const limit = dumpAll ? entries.length : 20;
    console.log("Aggregated entries:");
    entries.slice(0, limit).forEach((entry) => {
      console.log(
        `- ${entry.day} ${entry.model} input=${entry.tokens.input} output=${entry.tokens.output} cache=${entry.tokens.cache} thinking=${entry.tokens.thinking} total=${entry.tokens.total}`
      );
    });
    if (!dumpAll && entries.length > limit) {
      console.log(`...and ${entries.length - limit} more. Use --dump-all to show all.`);
    }
    console.log("");
  }

  if (dumpPayload) {
    const fallbackInfo = getOrCreateDeviceInfo();
    const fallback = buildSyncPayload(
      {},
      { deviceId: fallbackInfo.deviceId, deviceName: fallbackInfo.deviceName }
    );
    console.log(JSON.stringify(result.payload ?? fallback, null, 2));
    console.log("");
  }

  if (!result.localOnly && result.rateLimit?.limited && !force) {
    console.log(`Rate limited until ${result.rateLimit.nextAllowedAt ?? "later"}.`);
  }

  if (!result.localOnly && result.auth && result.auth.status !== "valid") {
    console.log(result.auth.message ?? "Auth token missing or invalid. Run `brag login`.");
  }

  if (result.queue) {
    console.log(`Queue pending: ${result.queue.pending}`);
    if (result.queue.flushed > 0) {
      console.log(`Queue flushed: ${result.queue.flushed}`);
    }
    if (result.queue.enqueued) {
      console.log("Queued payload for retry.");
    }
  }

  if (result.api?.url) {
    if (result.status === "success") {
      console.log(`Uploaded to ${result.api.url}.`);
    } else if (result.status === "error") {
      console.error(`Sync failed (${result.api.error ?? "unknown error"}).`);
    } else if (result.message) {
      console.log(result.message);
    }
  } else if (result.message) {
    console.log(result.message);
  }

  return result.status === "error" ? 1 : 0;
}
