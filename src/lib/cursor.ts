import type { RequiredTotals } from "./usage-types";

export type FileCursor = {
  lastLine?: number;
  lastSize?: number;
  lastMtimeMs?: number;
  lastModel?: string;
  lastCumulativeTotals?: RequiredTotals;
  lastSignatures?: string[];
};
