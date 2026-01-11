import type { UsageRecord } from "./usage-parser";
import type { RequiredTotals, TokenTotals } from "./usage-types";

export type AggregatedUsage = {
  day: string;
  model: string;
  tokens: RequiredTotals;
};

function addToken(target: RequiredTotals, key: keyof TokenTotals, value?: number): void {
  if (value === undefined) {
    return;
  }
  target[key] += value;
}

export function aggregateUsage(records: UsageRecord[]): AggregatedUsage[] {
  const byKey = new Map<string, AggregatedUsage>();
  const cumulativeBySource = new Map<string, AggregatedUsage>();

  for (const record of records) {
    if (record.mode === "cumulative") {
      const cumulativeKey = `${record.day}::${record.model}::${record.source}`;
      let entry = cumulativeBySource.get(cumulativeKey);
      if (!entry) {
        entry = {
          day: record.day,
          model: record.model,
          tokens: {
            input: 0,
            output: 0,
            cache: 0,
            thinking: 0,
            total: 0,
          },
        };
        cumulativeBySource.set(cumulativeKey, entry);
      }

      entry.tokens.input = Math.max(entry.tokens.input, record.tokens.input ?? 0);
      entry.tokens.output = Math.max(entry.tokens.output, record.tokens.output ?? 0);
      entry.tokens.cache = Math.max(entry.tokens.cache, record.tokens.cache ?? 0);
      entry.tokens.thinking = Math.max(entry.tokens.thinking, record.tokens.thinking ?? 0);
      entry.tokens.total = Math.max(entry.tokens.total, record.tokens.total ?? 0);
      continue;
    }

    const key = `${record.day}::${record.model}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        day: record.day,
        model: record.model,
        tokens: {
          input: 0,
          output: 0,
          cache: 0,
          thinking: 0,
          total: 0,
        },
      };
      byKey.set(key, entry);
    }

    addToken(entry.tokens, "input", record.tokens.input);
    addToken(entry.tokens, "output", record.tokens.output);
    addToken(entry.tokens, "cache", record.tokens.cache);
    addToken(entry.tokens, "thinking", record.tokens.thinking);
    addToken(entry.tokens, "total", record.tokens.total);
  }

  for (const entry of cumulativeBySource.values()) {
    const key = `${entry.day}::${entry.model}`;
    let aggregate = byKey.get(key);
    if (!aggregate) {
      aggregate = {
        day: entry.day,
        model: entry.model,
        tokens: {
          input: 0,
          output: 0,
          cache: 0,
          thinking: 0,
          total: 0,
        },
      };
      byKey.set(key, aggregate);
    }

    addToken(aggregate.tokens, "input", entry.tokens.input);
    addToken(aggregate.tokens, "output", entry.tokens.output);
    addToken(aggregate.tokens, "cache", entry.tokens.cache);
    addToken(aggregate.tokens, "thinking", entry.tokens.thinking);
    addToken(aggregate.tokens, "total", entry.tokens.total);
  }

  const aggregated = Array.from(byKey.values());
  for (const entry of aggregated) {
    const outputTotal = entry.tokens.output + entry.tokens.thinking;
    // Cache is a subset of input; if cache exceeds input, treat input as uncached and add cache.
    const inputTotal =
      entry.tokens.cache > entry.tokens.input
        ? entry.tokens.input + entry.tokens.cache
        : entry.tokens.input > 0
          ? entry.tokens.input
          : entry.tokens.cache;
    const baseSum = inputTotal + outputTotal;
    if (baseSum > 0) {
      entry.tokens.total = baseSum;
      continue;
    }
    if (entry.tokens.total === 0) {
      const fallbackSum =
        entry.tokens.input +
        entry.tokens.output +
        entry.tokens.cache +
        entry.tokens.thinking;
      if (fallbackSum > 0) {
        entry.tokens.total = fallbackSum;
      }
    }
  }

  aggregated.sort((a, b) => {
    if (a.day !== b.day) {
      return a.day.localeCompare(b.day);
    }
    return a.model.localeCompare(b.model);
  });

  return aggregated;
}
