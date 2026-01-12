import { describe, expect, test } from "bun:test";

import { aggregateUsage } from "../src/lib/usage-aggregate";
import { applyCumulativeAdjustments } from "../src/lib/usage-state";
import type { UsageRecord } from "../src/lib/usage-parser";

describe("aggregateUsage", () => {
  test("sums token totals per day/model and normalizes total", () => {
    const records: UsageRecord[] = [
      {
        day: "2026-01-02",
        model: "gpt-4",
        source: "a",
        tokens: { input: 10, output: 5 },
        mode: "delta",
      },
      {
        day: "2026-01-02",
        model: "gpt-4",
        source: "b",
        tokens: { input: 3, output: 2 },
        mode: "delta",
      },
    ];

    const aggregated = aggregateUsage(records);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]?.tokens.input).toBe(13);
    expect(aggregated[0]?.tokens.output).toBe(7);
    expect(aggregated[0]?.tokens.total).toBe(20);
  });

  test("ignores cumulative records", () => {
    const records: UsageRecord[] = [
      {
        day: "2026-01-03",
        model: "gpt-4",
        source: "source-a",
        tokens: { input: 5, output: 2, total: 7 },
        mode: "cumulative",
      },
    ];

    const aggregated = aggregateUsage(records);
    expect(aggregated).toHaveLength(0);
  });

  test("does not double count cache or thinking in totals", () => {
    const records: UsageRecord[] = [
      {
        day: "2026-01-06",
        model: "gpt-4",
        source: "a",
        tokens: { input: 10, output: 6, cache: 4, thinking: 2, total: 0 },
        mode: "delta",
      },
    ];

    const aggregated = aggregateUsage(records);
    expect(aggregated[0]?.tokens.total).toBe(16);
  });
});

describe("applyCumulativeAdjustments", () => {
  test("drops cumulative records and warns", () => {
    const record: UsageRecord = {
      day: "2026-01-04",
      model: "gpt-4",
      source: "source-a",
      tokens: { input: 10, output: 5, total: 15 },
      mode: "cumulative",
    };

    const adjusted = applyCumulativeAdjustments([record], {});
    expect(adjusted.records).toHaveLength(0);
    expect(adjusted.warnings.length).toBeGreaterThan(0);
  });
});
