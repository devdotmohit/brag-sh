export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_JITTER_MS = 2 * 60 * 1000;

export function getNextAllowedAt(lastSuccessAt?: string): Date | null {
  if (!lastSuccessAt) {
    return null;
  }
  const parsed = Date.parse(lastSuccessAt);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed + SYNC_INTERVAL_MS);
}

export function getRateLimitStatus(
  lastSuccessAt?: string,
  nowMs = Date.now()
): { limited: boolean; nextAllowedAt?: string } {
  const nextAllowedAt = getNextAllowedAt(lastSuccessAt);
  if (!nextAllowedAt) {
    return { limited: false };
  }
  const limited = nowMs < nextAllowedAt.getTime();
  return { limited, nextAllowedAt: nextAllowedAt.toISOString() };
}

export function computeNextRun(
  baseIso?: string,
  nowMs = Date.now(),
  jitterMs = DEFAULT_JITTER_MS
): { delayMs: number; nextRunAt: string } {
  const base = baseIso ? Date.parse(baseIso) : nowMs;
  const baseTime = Number.isNaN(base) ? nowMs : base;
  const jitter = Math.floor(Math.random() * jitterMs);
  const target = baseTime + SYNC_INTERVAL_MS + jitter;
  const delayMs = Math.max(0, target - nowMs);
  return { delayMs, nextRunAt: new Date(target).toISOString() };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}
