import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir } from "./config";
import type { SyncPayload } from "./payload";

export type QueueItem = {
  id: string;
  createdAt: string;
  payload: SyncPayload;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
};

const MAX_QUEUE_SIZE = 20;

function getQueueFilePath(): string {
  return join(getConfigDir(), "queue.json");
}

export function readQueue(): QueueItem[] {
  const path = getQueueFilePath();
  if (!existsSync(path)) {
    return [];
  }
  const raw = readFileSync(path, "utf8");
  let parsed: QueueItem[];
  try {
    parsed = JSON.parse(raw) as QueueItem[];
  } catch {
    throw new Error(`Invalid queue JSON at ${path}.`);
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed;
}

export function writeQueue(items: QueueItem[]): void {
  const path = getQueueFilePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const trimmed = items.slice(-MAX_QUEUE_SIZE);
  const payload = JSON.stringify(trimmed, null, 2);
  writeFileSync(path, `${payload}\n`, { mode: 0o600 });
}

export function enqueuePayload(
  payload: SyncPayload,
  reason?: string
): QueueItem[] {
  const queue = readQueue();
  const item: QueueItem = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    payload,
    attempts: 0,
    lastError: reason,
  };
  queue.push(item);
  writeQueue(queue);
  return queue;
}

export function updateQueue(items: QueueItem[]): void {
  writeQueue(items);
}
