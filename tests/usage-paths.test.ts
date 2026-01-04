import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverUsageSources } from "../src/lib/usage";

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "brag-usage-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("discoverUsageSources", () => {
  test("returns a file source when usagePath points to a file", () => {
    withTempDir((dir) => {
      const file = join(dir, "usage.json");
      writeFileSync(file, "{}\n");
      const result = discoverUsageSources({ version: 1, usagePath: file });
      expect(result.warnings.length).toBe(0);
      expect(result.sources).toEqual([{ path: file, kind: "file" }]);
    });
  });

  test("includes usage subdirectories when usagePath points to a directory", () => {
    withTempDir((dir) => {
      const usageDir = join(dir, "usage");
      mkdirSync(usageDir, { recursive: true });
      const entry = join(usageDir, "session.jsonl");
      writeFileSync(entry, "{}\n");
      const result = discoverUsageSources({ version: 1, usagePath: dir });
      expect(result.warnings.length).toBe(0);
      expect(result.sources.some((source) => source.kind === "directory")).toBe(true);
      expect(result.sources.some((source) => source.path === entry)).toBe(true);
    });
  });

  test("returns a warning when usagePath is missing", () => {
    const result = discoverUsageSources({
      version: 1,
      usagePath: join(tmpdir(), "brag-missing-usage-path"),
    });
    expect(result.sources.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
