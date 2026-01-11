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
        tokens: { input: 10, output: 5, total: 0 },
        mode: "delta",
      },
      {
        day: "2026-01-02",
        model: "gpt-4",
        source: "b",
        tokens: { input: 3, output: 2, total: 4 },
        mode: "delta",
      },
    ];

    const aggregated = aggregateUsage(records);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]?.tokens.input).toBe(13);
    expect(aggregated[0]?.tokens.output).toBe(7);
    expect(aggregated[0]?.tokens.total).toBe(20);
  });

  test("uses max per source for cumulative records", () => {
    const records: UsageRecord[] = [
      {
        day: "2026-01-03",
        model: "gpt-4",
        source: "source-a",
        tokens: { input: 5, output: 2, total: 7 },
        mode: "cumulative",
      },
      {
        day: "2026-01-03",
        model: "gpt-4",
        source: "source-a",
        tokens: { input: 3, output: 1, total: 4 },
        mode: "cumulative",
      },
      {
        day: "2026-01-03",
        model: "gpt-4",
        source: "source-b",
        tokens: { input: 2, output: 1, total: 3 },
        mode: "cumulative",
      },
    ];

    const aggregated = aggregateUsage(records);
    expect(aggregated[0]?.tokens.input).toBe(7);
    expect(aggregated[0]?.tokens.output).toBe(3);
    expect(aggregated[0]?.tokens.total).toBe(10);
  });

  test("treats cached input as a subset and includes thinking in totals", () => {
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
    expect(aggregated[0]?.tokens.total).toBe(18);
  });
});

describe("applyCumulativeAdjustments", () => {
  test("emits deltas and skips idempotent cumulative updates", () => {
    const base: UsageRecord = {
      day: "2026-01-04",
      model: "gpt-4",
      source: "source-a",
      tokens: { input: 10, output: 5, total: 15 },
      mode: "cumulative",
    };

    const first = applyCumulativeAdjustments([base], {});
    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.tokens.total).toBe(15);

    const second = applyCumulativeAdjustments([base], first.cumulative);
    expect(second.records).toHaveLength(0);
  });

  test("handles cumulative resets by clamping deltas to zero", () => {
    const record: UsageRecord = {
      day: "2026-01-05",
      model: "gpt-4",
      source: "source-a",
      tokens: { input: 5, output: 5, total: 10 },
      mode: "cumulative",
    };

    const previous = {
      "source-a::2026-01-05::gpt-4": {
        input: 7,
        output: 8,
        cache: 0,
        thinking: 0,
        total: 15,
      },
    };

    const adjusted = applyCumulativeAdjustments([record], previous);
    expect(adjusted.records).toHaveLength(0);
    expect(adjusted.warnings.length).toBeGreaterThan(0);
  });
});
