import type { AggregatedUsage } from "./usage-aggregate";
import type { UsageRecord } from "./usage-parser";
import type { RequiredTotals, TokenTotals } from "./usage-types";

export function emptyTotals(): RequiredTotals {
  return {
    input: 0,
    output: 0,
    cache: 0,
    thinking: 0,
    total: 0,
  };
}

function addTotals(target: RequiredTotals, delta: TokenTotals): void {
  target.input += delta.input ?? 0;
  target.output += delta.output ?? 0;
  target.cache += delta.cache ?? 0;
  target.thinking += delta.thinking ?? 0;
  target.total += delta.total ?? 0;
}

export function mergeAggregates(
  existing: Record<string, RequiredTotals>,
  aggregates: AggregatedUsage[]
): Record<string, RequiredTotals> {
  const next: Record<string, RequiredTotals> = { ...existing };

  for (const aggregate of aggregates) {
    const key = `${aggregate.day}::${aggregate.model}`;
    const entry = next[key] ?? emptyTotals();
    addTotals(entry, aggregate.tokens);
    next[key] = entry;
  }

  return next;
}

export function applyCumulativeAdjustments(
  records: UsageRecord[],
  _cumulative: Record<string, RequiredTotals> = {}
): {
  records: UsageRecord[];
  cumulative: Record<string, RequiredTotals>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const adjusted = records.filter((record) => record.mode !== "cumulative");
  if (adjusted.length !== records.length) {
    warnings.push("Skipped cumulative total_token_usage entries; expected per-file cursor deltas.");
  }

  return { records: adjusted, cumulative: {}, warnings };
}
