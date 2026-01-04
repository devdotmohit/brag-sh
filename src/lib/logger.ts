import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir } from "./config";

type LogLevel = "info" | "warn" | "error";

const LOG_DIR = "logs";
const LOG_FILE = "brag.log";
const MAX_LOG_BYTES = 1_000_000;
const MAX_LOG_FILES = 5;
const REDACT_KEYS = ["token", "authorization", "secret", "password", "cookie"];

function getLogPath(): string {
  return join(getConfigDir(), LOG_DIR, LOG_FILE);
}

function ensureLogDir(): void {
  const dir = join(getConfigDir(), LOG_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function shouldRotate(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  return statSync(path).size >= MAX_LOG_BYTES;
}

function rotateLogs(path: string): void {
  if (!shouldRotate(path)) {
    return;
  }

  for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
    const src = `${path}.${index}`;
    const dest = `${path}.${index + 1}`;
    if (existsSync(src)) {
      renameSync(src, dest);
    }
  }

  renameSync(path, `${path}.1`);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACT_KEYS.some((needle) => normalized.includes(needle));
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[Truncated]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      output[key] = shouldRedactKey(key) ? "[REDACTED]" : sanitize(entry, depth + 1);
    }
    return output;
  }

  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}…`;
  }

  return value;
}

export function logEvent(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  try {
    ensureLogDir();
    const path = getLogPath();
    rotateLogs(path);
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      context: context ? sanitize(context) : undefined,
    };
    const line = `${JSON.stringify(payload)}\n`;
    writeFileSync(path, line, { flag: "a", mode: 0o600 });
  } catch {
    // Logging is best-effort; avoid surfacing errors to users.
  }
}
