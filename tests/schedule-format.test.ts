import { describe, expect, test } from "bun:test";

import { formatSystemdArg, formatWindowsArg } from "../src/lib/schedule";

describe("schedule arg formatting", () => {
  test("leaves simple args untouched", () => {
    expect(formatSystemdArg("plain")).toBe("plain");
    expect(formatWindowsArg("plain")).toBe("plain");
  });

  test("quotes args with spaces", () => {
    expect(formatSystemdArg("with space")).toBe("\"with space\"");
    expect(formatWindowsArg("with space")).toBe("\"with space\"");
  });

  test("escapes quotes inside args", () => {
    expect(formatSystemdArg("path \"with\" quote")).toBe(
      "\"path \\\"with\\\" quote\""
    );
    expect(formatWindowsArg("path \"with\" quote")).toBe(
      "\"path \\\"with\\\" quote\""
    );
  });
});
