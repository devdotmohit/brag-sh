import type { RequiredTotals } from "./usage-types";

export type SyncPayloadEntry = {
  day: string;
  model: string;
  tokens: RequiredTotals;
};

export type SyncPayload = {
  version: 1;
  generatedAt: string;
  deviceId?: string;
  deviceName?: string;
  totals: SyncPayloadEntry[];
};

export function buildSyncPayload(
  dailyTotals: Record<string, RequiredTotals>,
  options: { generatedAt?: string; deviceId?: string; deviceName?: string } = {}
): SyncPayload {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const deviceId = options.deviceId?.trim() || undefined;
  const deviceName = options.deviceName?.trim() || undefined;
  const totals: SyncPayloadEntry[] = Object.entries(dailyTotals).map(
    ([key, tokens]) => {
      const [day, model] = key.split("::");
      return {
        day,
        model,
        tokens,
      };
    }
  );

  totals.sort((a, b) => {
    if (a.day !== b.day) {
      return a.day.localeCompare(b.day);
    }
    return a.model.localeCompare(b.model);
  });

  return {
    version: 1,
    generatedAt,
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    totals,
  };
}
