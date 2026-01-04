import { readFileSync } from "node:fs";

const FALLBACK_VERSION = "0.0.0";

export function readPackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(packageJsonUrl, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
