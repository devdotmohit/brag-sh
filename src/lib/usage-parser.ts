import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { createInterface } from "node:readline";

import type { FileCursor } from "./cursor";
import type { UsageSource } from "./usage";
import type { TokenTotals } from "./usage-types";

export type UsageRecord = {
  day: string;
  model: string;
  tokens: TokenTotals;
  source: string;
  mode?: "delta" | "cumulative";
};

export type ParseResult = {
  records: UsageRecord[];
  warnings: string[];
};

export type ParseOutput = ParseResult & {
  cursors: Record<string, FileCursor>;
};

const ARRAY_KEYS = ["records", "entries", "items", "usage", "data", "events", "sessions"];

const MODEL_KEYS = [
  "model",
  "model_name",
  "modelName",
  "model_id",
  "modelId",
  "model_slug",
  "modelSlug",
  "base_model",
  "baseModel",
  "engine",
  "deployment",
  "deployment_id",
  "deploymentId",
];
const DAY_KEYS = ["day", "date", "usage_date", "usageDate"];
const TIME_KEYS = [
  "timestamp",
  "ts",
  "created_at",
  "createdAt",
  "time",
  "start_time",
  "startTime",
];

const TOKEN_FIELD_MAP: Record<keyof TokenTotals, string[]> = {
  input: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  output: [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "response_tokens",
    "responseTokens",
  ],
  cache: [
    "cache_tokens",
    "cacheTokens",
    "cached_tokens",
    "cachedTokens",
    "cached_input_tokens",
    "cachedInputTokens",
  ],
  thinking: [
    "thinking_tokens",
    "thinkingTokens",
    "reasoning_tokens",
    "reasoningTokens",
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ],
  total: ["total_tokens", "totalTokens", "tokens", "token_count", "tokenCount"],
};

const TOKEN_CONTEXT_KEYS = [
  "usage",
  "token_usage",
  "tokenUsage",
  "tokens",
  "payload",
  "info",
];

const NESTED_CONTEXT_KEYS = [
  "payload",
  "info",
  "metadata",
  "context",
  "request",
  "model_info",
  "modelInfo",
  "model_config",
  "modelConfig",
];

type TokenExtraction = {
  tokens: TokenTotals;
  warning?: string;
  mode: "delta" | "cumulative";
};

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstArrayValue(obj: Record<string, unknown>): unknown[] | null {
  for (const key of ARRAY_KEYS) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseDateString(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function parseTimestamp(value: number): string | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function extractDay(obj: Record<string, unknown>): string | null {
  for (const key of DAY_KEYS) {
    const value = obj[key];
    if (typeof value === "string") {
      const parsed = parseDateString(value);
      if (parsed) {
        return parsed;
      }
    } else if (typeof value === "number") {
      const parsed = parseTimestamp(value);
      if (parsed) {
        return parsed;
      }
    }
  }

  for (const key of TIME_KEYS) {
    const value = obj[key];
    if (typeof value === "number") {
      const parsed = parseTimestamp(value);
      if (parsed) {
        return parsed;
      }
    }
    if (typeof value === "string") {
      const asNumber = Number(value);
      if (!Number.isNaN(asNumber)) {
        const parsed = parseTimestamp(asNumber);
        if (parsed) {
          return parsed;
        }
      }
      const parsed = parseDateString(value);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function collectContexts(obj: Record<string, unknown>): Record<string, unknown>[] {
  const contexts: Record<string, unknown>[] = [obj];

  for (const key of TOKEN_CONTEXT_KEYS) {
    const nested = obj[key];
    if (isRecordObject(nested)) {
      contexts.push(nested);
    }
  }

  for (const key of NESTED_CONTEXT_KEYS) {
    const nested = obj[key];
    if (isRecordObject(nested)) {
      contexts.push(nested);
      for (const innerKey of NESTED_CONTEXT_KEYS) {
        const inner = nested[innerKey];
        if (isRecordObject(inner)) {
          contexts.push(inner);
        }
      }
    }
  }

  return contexts;
}

function isTokenEvent(obj: Record<string, unknown>): boolean {
  if (obj.type === "token_count") {
    return true;
  }
  const payload = obj.payload;
  if (isRecordObject(payload) && payload.type === "token_count") {
    return true;
  }
  if (extractTokenUsageObject(obj)) {
    return true;
  }
  return hasTokenFields(obj);
}

function hasTokenFields(obj: Record<string, unknown>): boolean {
  const contexts = collectContexts(obj);
  for (const ctx of contexts) {
    for (const fieldNames of Object.values(TOKEN_FIELD_MAP)) {
      for (const field of fieldNames) {
        if (ctx[field] !== undefined) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractModel(obj: Record<string, unknown>): string | null {
  const contexts = collectContexts(obj);
  for (const ctx of contexts) {
    for (const key of MODEL_KEYS) {
      const value = ctx[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function extractTokenUsageObject(
  obj: Record<string, unknown>
): { usage: Record<string, unknown>; mode: "last" | "total" } | null {
  const contexts = collectContexts(obj);

  for (const ctx of contexts) {
    const last = ctx["last_token_usage"];
    if (isRecordObject(last)) {
      return { usage: last, mode: "last" };
    }
    const total = ctx["total_token_usage"];
    if (isRecordObject(total)) {
      return { usage: total, mode: "total" };
    }
  }

  return null;
}

function extractTokens(obj: Record<string, unknown>): TokenExtraction | null {
  const contexts = collectContexts(obj);
  const eventUsage = extractTokenUsageObject(obj);

  if (eventUsage) {
    contexts.unshift(eventUsage.usage);
  }

  const totals: TokenTotals = {};

  for (const [tokenKey, fieldNames] of Object.entries(TOKEN_FIELD_MAP) as [
    keyof TokenTotals,
    string[],
  ][]) {
    for (const ctx of contexts) {
      for (const field of fieldNames) {
        const candidate = parseNumber(ctx[field]);
        if (candidate !== undefined) {
          totals[tokenKey] = candidate;
          break;
        }
      }
      if (totals[tokenKey] !== undefined) {
        break;
      }
    }
  }

  const hasTokens = Object.values(totals).some((value) => value !== undefined);
  if (!hasTokens) {
    return null;
  }

  if (eventUsage?.mode === "total") {
    return {
      tokens: totals,
      warning: "Using total_token_usage; this may be cumulative for the session.",
      mode: "cumulative",
    };
  }

  return { tokens: totals, mode: "delta" };
}

function normalizeRecord(
  value: unknown,
  source: string
): { record: UsageRecord | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecordObject(value)) {
    return { record: null, warnings };
  }

  if (!isTokenEvent(value)) {
    return { record: null, warnings };
  }

  const day = extractDay(value);
  if (!day) {
    warnings.push("Skipping entry with missing day/timestamp.");
    return { record: null, warnings };
  }

  let model = extractModel(value);
  if (!model) {
    model = "unknown";
  }

  const tokenExtraction = extractTokens(value);
  if (!tokenExtraction) {
    warnings.push("Skipping entry with missing token counts.");
    return { record: null, warnings };
  }

  if (tokenExtraction.warning) {
    warnings.push(tokenExtraction.warning);
  }

  return {
    record: {
      day,
      model,
      tokens: tokenExtraction.tokens,
      source,
      mode: tokenExtraction.mode,
    },
    warnings,
  };
}

function extractEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecordObject(value)) {
    const arrayValue = firstArrayValue(value);
    if (arrayValue) {
      return arrayValue;
    }
    return [value];
  }
  return [];
}

function parseJsonValue(value: unknown, source: string): ParseResult {
  const entries = extractEntries(value);
  const records: UsageRecord[] = [];
  const warnings: string[] = [];

  if (entries.length === 0) {
    return { records, warnings: ["No usage entries found in JSON."] };
  }

  for (const entry of entries) {
    const { record, warnings: entryWarnings } = normalizeRecord(entry, source);
    warnings.push(...entryWarnings);
    if (record) {
      records.push(record);
    }
  }

  return { records, warnings };
}

async function parseJsonFile(filePath: string): Promise<ParseResult> {
  const raw = readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return parseJsonValue(parsed, filePath);
  } catch (error) {
    return {
      records: [],
      warnings: [
        error instanceof Error ? error.message : "Invalid JSON.",
        "Falling back to JSONL parsing.",
      ],
    };
  }
}

type FileParseResult = ParseResult & { cursor?: FileCursor };

async function parseJsonLinesFileWithCursor(
  filePath: string,
  cursor?: FileCursor
): Promise<FileParseResult> {
  const records: UsageRecord[] = [];
  const warnings: string[] = [];
  const stats = statSync(filePath);
  let lastModel: string | null = cursor?.lastModel ?? null;

  if (
    cursor &&
    cursor.lastSize === stats.size &&
    cursor.lastMtimeMs === stats.mtimeMs
  ) {
    return { records, warnings, cursor };
  }

  let startLine = cursor?.lastLine ?? 0;
  if (cursor?.lastSize !== undefined && stats.size < cursor.lastSize) {
    warnings.push("File size shrank; resetting cursor.");
    startLine = 0;
    lastModel = null;
  }

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let sawNewLines = false;

  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber <= startLine) {
      continue;
    }
    sawNewLines = true;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecordObject(parsed)) {
        const explicitModel = extractModel(parsed);
        if (explicitModel) {
          lastModel = explicitModel;
        }

        if (lastModel && isTokenEvent(parsed) && !explicitModel) {
          parsed.model = lastModel;
        }
      }
      const result = parseJsonValue(parsed, filePath);
      records.push(...result.records);
      warnings.push(...result.warnings.map((warning) => `Line ${lineNumber}: ${warning}`));
    } catch (error) {
      warnings.push(
        `Line ${lineNumber}: ${error instanceof Error ? error.message : "Invalid JSON."}`
      );
    }
  }

  if (records.length === 0 && sawNewLines) {
    warnings.push("No token usage entries found in file.");
  }

  const nextCursor: FileCursor = {
    lastLine: lineNumber,
    lastSize: stats.size,
    lastMtimeMs: stats.mtimeMs,
    ...(lastModel ? { lastModel } : {}),
  };

  return { records, warnings, cursor: nextCursor };
}

async function parseJsonFileWithCursor(
  filePath: string,
  cursor?: FileCursor
): Promise<FileParseResult> {
  const stats = statSync(filePath);
  if (
    cursor &&
    cursor.lastSize === stats.size &&
    cursor.lastMtimeMs === stats.mtimeMs
  ) {
    return { records: [], warnings: [], cursor };
  }

  const result = await parseJsonFile(filePath);
  if (result.records.length > 0 || result.warnings.length === 0) {
    return {
      ...result,
      cursor: {
        lastLine: 1,
        lastSize: stats.size,
        lastMtimeMs: stats.mtimeMs,
      },
    };
  }

  const jsonlResult = await parseJsonLinesFileWithCursor(filePath, cursor);
  return {
    records: jsonlResult.records,
    warnings: [...result.warnings, ...jsonlResult.warnings],
    cursor: jsonlResult.cursor,
  };
}

async function parseUsageFileWithCursor(
  filePath: string,
  cursor?: FileCursor
): Promise<FileParseResult> {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".jsonl") {
    return parseJsonLinesFileWithCursor(filePath, cursor);
  }
  return parseJsonFileWithCursor(filePath, cursor);
}

export async function parseUsageSources(
  sources: UsageSource[],
  options: { cursors?: Record<string, FileCursor> } = {}
): Promise<ParseOutput> {
  const records: UsageRecord[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const nextCursors: Record<string, FileCursor> = { ...(options.cursors ?? {}) };

  for (const source of sources) {
    if (source.kind !== "file") {
      continue;
    }
    if (seen.has(source.path)) {
      continue;
    }
    seen.add(source.path);
    try {
      const result = await parseUsageFileWithCursor(source.path, options.cursors?.[source.path]);
      records.push(...result.records);
      warnings.push(...result.warnings.map((warning) => `${source.path}: ${warning}`));
      if (result.cursor) {
        nextCursors[source.path] = result.cursor;
      }
    } catch (error) {
      warnings.push(
        `${source.path}: ${error instanceof Error ? error.message : "Failed to parse usage file."}`
      );
    }
  }

  if (records.some((record) => record.model === "unknown")) {
    warnings.push("Some entries are missing model info; recorded as 'unknown'.");
  }

  return { records, warnings, cursors: nextCursors };
}
