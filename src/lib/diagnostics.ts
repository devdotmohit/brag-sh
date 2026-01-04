const REDACT_KEYS = ["token", "authorization", "secret", "password", "cookie"];
const REDACT_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/gi,
  /(token|authorization|secret|password|cookie)\s*[:=]\s*([^\s]+)/gi,
];

let debugEnabled = false;

export type SafeErrorContext = {
  at: string;
  code: string;
  message: string;
  hint?: string;
  status?: number;
  url?: string;
};

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACT_KEYS.some((needle) => normalized.includes(needle));
}

function sanitizeContext(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[Truncated]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeContext(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      output[key] = shouldRedactKey(key)
        ? "[REDACTED]"
        : sanitizeContext(entry, depth + 1);
    }
    return output;
  }

  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}…`;
  }

  return value;
}

export function sanitizeMessage(message: string): string {
  let sanitized = message.replace(/\s+/g, " ").trim();
  for (const pattern of REDACT_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, key) => {
      if (typeof key === "string") {
        return `${key}: [REDACTED]`;
      }
      return "Bearer [REDACTED]";
    });
  }
  if (sanitized.length > 200) {
    sanitized = `${sanitized.slice(0, 200)}…`;
  }
  return sanitized || "Request failed.";
}

function sanitizeUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function buildErrorContext(input: {
  code: string;
  message: string;
  hint?: string;
  status?: number;
  url?: string;
  at?: string;
}): SafeErrorContext {
  const safeMessage = sanitizeMessage(input.message);
  const safeHint = input.hint ? sanitizeMessage(input.hint) : undefined;
  const safeUrl = sanitizeUrl(input.url);
  const context: SafeErrorContext = {
    at: input.at ?? new Date().toISOString(),
    code: input.code,
    message: safeMessage,
  };
  if (safeHint) {
    context.hint = safeHint;
  }
  if (typeof input.status === "number") {
    context.status = input.status;
  }
  if (safeUrl) {
    context.url = safeUrl;
  }
  return context;
}

export function debugLog(message: string, context?: Record<string, unknown>): void {
  if (!debugEnabled) {
    return;
  }
  const safeContext = context ? sanitizeContext(context) : undefined;
  if (safeContext) {
    console.error(`[debug] ${message} ${JSON.stringify(safeContext)}`);
  } else {
    console.error(`[debug] ${message}`);
  }
}
