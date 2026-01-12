const REPO_URL = "https://github.com/devdotmohit/brag-sh";

const DISCLOSURE_LINES = [
  "Data collection:",
  "  Usage Leaderboard reads Codex usage logs under ~/.codex (or configured usagePath).",
  "  It only uploads aggregated daily token totals by model and token type,",
  "  plus a random device identifier and device name (from your host name) for per-device rollups.",
  `Source: ${REPO_URL}`,
];

export function printDisclosure(): void {
  for (const line of DISCLOSURE_LINES) {
    console.log(line);
  }
}
