import { describe, expect, test } from "bun:test";

import { buildSyncPayload } from "../src/lib/payload";

describe("buildSyncPayload", () => {
  test("sorts totals by day then model", () => {
    const payload = buildSyncPayload(
      {
        "2026-01-02::zeta": {
          input: 1,
          output: 1,
          cache: 0,
          thinking: 0,
          total: 2,
        },
        "2026-01-01::beta": {
          input: 2,
          output: 0,
          cache: 0,
          thinking: 0,
          total: 2,
        },
        "2026-01-01::alpha": {
          input: 3,
          output: 3,
          cache: 0,
          thinking: 0,
          total: 6,
        },
      },
      { generatedAt: "2026-01-02T00:00:00.000Z" }
    );

    expect(payload.version).toBe(1);
    expect(payload.generatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(payload.totals.map((entry) => `${entry.day}::${entry.model}`)).toEqual([
      "2026-01-01::alpha",
      "2026-01-01::beta",
      "2026-01-02::zeta",
    ]);
  });
});
