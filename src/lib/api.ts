import type { Config } from "./config";
import type { SyncPayload } from "./payload";
import { sanitizeMessage } from "./diagnostics";
import { readPackageVersion } from "./version";

export type ApiResponse = {
  ok: boolean;
  status?: number;
  url?: string;
  body?: unknown;
  error?: string;
  attempts?: number;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
const DEFAULT_SYNC_PATH = "/v1/usage";

function readTimeoutEnv(): number | undefined {
  const raw = process.env.BRAG_API_TIMEOUT_MS;
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function joinUrl(base: string, path: string): string {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  const extraPath = path.startsWith("/") ? path : `/${path}`;
  baseUrl.pathname = `${basePath}${extraPath}`;
  return baseUrl.toString();
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function detectApiError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const status = record.status;
  if (record.ok === false || record.success === false || status === "error") {
    return (
      asString(record.error) ??
      asString(record.message) ??
      "API reported an error."
    );
  }
  return undefined;
}

function formatHttpStatusError(status: number): string {
  switch (status) {
    case 400:
      return "Invalid request. Please check your inputs.";
    case 401:
      return "Not authorized. Run brag login and try again.";
    case 403:
      return "Access denied. Run brag login and try again.";
    case 404:
      return "Endpoint not found. Check your API base URL.";
    case 408:
      return "Request timed out. Please retry.";
    case 429:
      return "Rate limited. Please retry later.";
    case 500:
      return "Server error. Please retry.";
    case 502:
    case 503:
    case 504:
      return "Service unavailable. Please retry shortly.";
    default:
      return `HTTP ${status}`;
  }
}

export function resolveSyncUrl(config: Config): { url?: string; error?: string } {
  const base = config.apiBaseUrl ?? process.env.BRAG_API_BASE_URL;
  if (!base) {
    return { error: "API base URL not configured." };
  }

  const path = process.env.BRAG_API_SYNC_PATH ?? DEFAULT_SYNC_PATH;
  try {
    const url = joinUrl(base, path);
    return { url };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid API base URL.",
    };
  }
}

export async function postSyncPayload(
  url: string,
  payload: SyncPayload,
  options: {
    timeoutMs?: number;
    token?: string;
    tokenType?: string;
  } = {}
): Promise<ApiResponse> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? readTimeoutEnv() ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const version = readPackageVersion();
  const userAgent = `brag-cli/${version} (${process.platform}; ${process.arch})`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent,
        ...(options.token
          ? { authorization: `${options.tokenType ?? "Bearer"} ${options.token}` }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = text;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    const apiError = detectApiError(body);
    const sanitizedApiError = apiError ? sanitizeMessage(apiError) : undefined;
    if (response.ok && sanitizedApiError) {
      return {
        ok: false,
        status: response.status,
        url,
        body,
        error: sanitizedApiError,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url,
        body,
        error: sanitizedApiError ?? formatHttpStatusError(response.status),
      };
    }

    return { ok: true, status: response.status, url, body };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Request failed.";
    return {
      ok: false,
      url,
      error: sanitizeMessage(message),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status?: number): boolean {
  if (!status) {
    return true;
  }
  if (status === 408 || status === 429) {
    return true;
  }
  return status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postSyncPayloadWithRetry(
  url: string,
  payload: SyncPayload,
  options: {
    timeoutMs?: number;
    token?: string;
    tokenType?: string;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  } = {}
): Promise<ApiResponse> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;

  let attempt = 0;
  let lastResponse: ApiResponse | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await postSyncPayload(url, payload, options);
    response.attempts = attempt;
    if (response.ok) {
      return response;
    }
    lastResponse = response;
    if (!isRetryableStatus(response.status)) {
      return response;
    }
    if (attempt >= maxAttempts) {
      break;
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    await sleep(delay + jitter);
  }

  return {
    ok: false,
    status: lastResponse?.status,
    url,
    error: lastResponse?.error ?? "Request failed after retries.",
    attempts: attempt,
  };
}
