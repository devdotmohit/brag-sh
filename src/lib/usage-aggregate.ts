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

  for (const record of records) {
    if (record.mode === "cumulative") {
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

  const aggregated = Array.from(byKey.values());
  for (const entry of aggregated) {
    if (entry.tokens.total === 0) {
      const fallbackSum = entry.tokens.input + entry.tokens.output;
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
