const REPO_URL = "https://github.com/bluppco/api-blupp-co";

const DISCLOSURE_LINES = [
  "Data collection:",
  "  Brag reads Codex usage logs under ~/.codex (or configured usagePath).",
  "  It only uploads aggregated daily token totals by model and token type,",
  "  plus a random device identifier for per-device rollups.",
  `Source: ${REPO_URL}`,
];

export function printDisclosure(): void {
  for (const line of DISCLOSURE_LINES) {
    console.log(line);
  }
}
