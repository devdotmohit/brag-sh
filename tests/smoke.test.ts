import { describe, expect, test } from "bun:test";

import { readPackageVersion } from "../src/lib/version";

describe("readPackageVersion", () => {
  test("returns a version string", () => {
    const version = readPackageVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });
});
