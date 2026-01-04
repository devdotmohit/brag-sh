import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir } from "./config";
import type { FileCursor } from "./cursor";
import type { SafeErrorContext } from "./diagnostics";
import type { RequiredTotals } from "./usage-types";

export type SyncState = {
  version: 1;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastStatus?: "success" | "error" | "skipped";
  lastError?: string;
  lastErrorContext?: SafeErrorContext;
  lastNote?: string;
  lastSourcesCount?: number;
  lastRecordsParsed?: number;
  lastAggregatedEntries?: number;
  lastTotalTokens?: number;
  lastWarningsCount?: number;
  fileCursors?: Record<string, FileCursor>;
  dailyTotals?: Record<string, RequiredTotals>;
  cumulativeTotals?: Record<string, RequiredTotals>;
};

const DEFAULT_STATE: SyncState = {
  version: 1,
};

function getStateFilePath(): string {
  return join(getConfigDir(), "state.json");
}

export function readSyncState(): SyncState {
  const statePath = getStateFilePath();
  if (!existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  const raw = readFileSync(statePath, "utf8");
  let parsed: SyncState;
  try {
    parsed = JSON.parse(raw) as SyncState;
  } catch {
    throw new Error(`Invalid sync state JSON at ${statePath}.`);
  }

  return { ...DEFAULT_STATE, ...parsed, version: 1 };
}

export function writeSyncState(state: SyncState): void {
  const statePath = getStateFilePath();
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ ...state, version: 1 }, null, 2);
  writeFileSync(statePath, `${payload}\n`, { mode: 0o600 });
}
