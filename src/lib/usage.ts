import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config";

export type UsageSource = {
  path: string;
  kind: "file" | "directory";
};

export type UsageDiscovery = {
  basePath: string;
  sources: UsageSource[];
  warnings: string[];
};

const USAGE_EXTENSIONS = new Set([".json", ".jsonl"]);
const KNOWN_SUBDIRS = ["usage", "sessions"];
const MAX_WALK_DEPTH = 4;
const EXCLUDED_FILENAMES = new Set(["history.jsonl"]);

function resolveCodexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome && envHome.trim()) {
    return envHome;
  }

  return join(homedir(), ".codex");
}

function listUsageFiles(dir: string): UsageSource[] {
  const sources: UsageSource[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (EXCLUDED_FILENAMES.has(entry.name)) {
      continue;
    }
    const lowerName = entry.name.toLowerCase();
    for (const ext of USAGE_EXTENSIONS) {
      if (lowerName.endsWith(ext)) {
        sources.push({ path: join(dir, entry.name), kind: "file" });
        break;
      }
    }
  }

  return sources;
}

function walkUsageFiles(dir: string, depth = 0): UsageSource[] {
  if (depth > MAX_WALK_DEPTH) {
    return [];
  }

  const sources: UsageSource[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(...walkUsageFiles(entryPath, depth + 1));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (EXCLUDED_FILENAMES.has(entry.name)) {
      continue;
    }
    const lowerName = entry.name.toLowerCase();
    for (const ext of USAGE_EXTENSIONS) {
      if (lowerName.endsWith(ext)) {
        sources.push({ path: entryPath, kind: "file" });
        break;
      }
    }
  }

  return sources;
}

export function discoverUsageSources(config: Config): UsageDiscovery {
  const isCustomPath = Boolean(config.usagePath?.trim());
  const basePath = config.usagePath?.trim() || resolveCodexHome();
  const warnings: string[] = [];

  if (!existsSync(basePath)) {
    warnings.push(`Usage path does not exist: ${basePath}`);
    return { basePath, sources: [], warnings };
  }

  let stats;
  try {
    stats = statSync(basePath);
  } catch (error) {
    warnings.push(
      `Unable to read usage path: ${error instanceof Error ? error.message : String(error)}`
    );
    return { basePath, sources: [], warnings };
  }

  if (stats.isFile()) {
    return { basePath, sources: [{ path: basePath, kind: "file" }], warnings };
  }

  if (!stats.isDirectory()) {
    warnings.push(`Usage path is not a file or directory: ${basePath}`);
    return { basePath, sources: [], warnings };
  }

  const sources: UsageSource[] = [];

  try {
    sources.push(...(isCustomPath ? walkUsageFiles(basePath) : listUsageFiles(basePath)));
  } catch (error) {
    warnings.push(
      `Unable to scan usage path ${basePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  for (const subdir of KNOWN_SUBDIRS) {
    const candidate = join(basePath, subdir);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const subStats = statSync(candidate);
      if (subStats.isDirectory()) {
        sources.push({ path: candidate, kind: "directory" });
        sources.push(...walkUsageFiles(candidate));
      } else if (subStats.isFile()) {
        sources.push({ path: candidate, kind: "file" });
      }
    } catch (error) {
      warnings.push(
        `Unable to inspect ${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return { basePath, sources, warnings };
}
