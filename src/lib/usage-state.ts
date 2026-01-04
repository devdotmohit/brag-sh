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

function normalizeTotals(totals?: TokenTotals): RequiredTotals {
  return {
    input: totals?.input ?? 0,
    output: totals?.output ?? 0,
    cache: totals?.cache ?? 0,
    thinking: totals?.thinking ?? 0,
    total: totals?.total ?? 0,
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
  cumulative: Record<string, RequiredTotals>
): {
  records: UsageRecord[];
  cumulative: Record<string, RequiredTotals>;
  warnings: string[];
} {
  const nextCumulative: Record<string, RequiredTotals> = { ...cumulative };
  const adjusted: UsageRecord[] = [];
  const warnings: string[] = [];
  const resetKeys = new Set<string>();

  for (const record of records) {
    if (record.mode !== "cumulative") {
      adjusted.push(record);
      continue;
    }

    const key = `${record.source}::${record.day}::${record.model}`;
    const previous = nextCumulative[key] ?? emptyTotals();
    const current = normalizeTotals(record.tokens);

    const delta: RequiredTotals = {
      input: current.input - previous.input,
      output: current.output - previous.output,
      cache: current.cache - previous.cache,
      thinking: current.thinking - previous.thinking,
      total: current.total - previous.total,
    };

    const hasReset =
      delta.input < 0 ||
      delta.output < 0 ||
      delta.cache < 0 ||
      delta.thinking < 0 ||
      delta.total < 0;

    if (hasReset) {
      if (!resetKeys.has(key)) {
        warnings.push(`Cumulative totals reset detected for ${record.source}.`);
        resetKeys.add(key);
      }
    }

    delta.input = Math.max(0, delta.input);
    delta.output = Math.max(0, delta.output);
    delta.cache = Math.max(0, delta.cache);
    delta.thinking = Math.max(0, delta.thinking);
    delta.total = Math.max(0, delta.total);

    if (
      delta.input === 0 &&
      delta.output === 0 &&
      delta.cache === 0 &&
      delta.thinking === 0 &&
      delta.total === 0
    ) {
      nextCumulative[key] = current;
      continue;
    }

    nextCumulative[key] = current;
    adjusted.push({
      ...record,
      tokens: delta,
      mode: "delta",
    });
  }

  return { records: adjusted, cumulative: nextCumulative, warnings };
}
