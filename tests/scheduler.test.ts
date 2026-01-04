import { describe, expect, test } from "bun:test";

import { getRateLimitStatus, SYNC_INTERVAL_MS } from "../src/lib/scheduler";

describe("getRateLimitStatus", () => {
  test("flags as limited when within interval", () => {
    const lastSuccess = "2026-01-01T00:00:00.000Z";
    const nowMs = Date.parse(lastSuccess) + 5 * 60 * 1000;
    const status = getRateLimitStatus(lastSuccess, nowMs);
    expect(status.limited).toBe(true);
    expect(status.nextAllowedAt).toBe(
      new Date(Date.parse(lastSuccess) + SYNC_INTERVAL_MS).toISOString()
    );
  });

  test("allows sync after interval passes", () => {
    const lastSuccess = "2026-01-01T00:00:00.000Z";
    const nowMs = Date.parse(lastSuccess) + SYNC_INTERVAL_MS + 1;
    const status = getRateLimitStatus(lastSuccess, nowMs);
    expect(status.limited).toBe(false);
  });

  test("handles invalid timestamps", () => {
    const status = getRateLimitStatus("not-a-date", Date.now());
    expect(status.limited).toBe(false);
    expect(status.nextAllowedAt).toBeUndefined();
  });
});
