# Usage Leaderboard CLI

Usage Leaderboard CLI aggregates Codex usage locally and syncs daily totals to the Usage Leaderboard API.

## Install

```bash
npm install -g brag-sh
# optional (Bun)
bun add -g brag-sh
```

The npm package name is `brag-sh`, but the installed command is `brag`.

## Quickstart

```bash
# set API base URL
brag config set apiBaseUrl https://usageleaderboard.com

# authenticate (device login)
brag login

# run a manual sync
brag sync

# check status
brag status
```

## Commands

Global options:

- `--debug`: Enable verbose, redacted diagnostics.

### `brag login`

- `--token <token>`: Authenticate with a token instead of device login.
- `--token-type <type>`: Token type (default `Bearer`).
- `--profile <name>`: Store credentials under a profile label.
- `--switch <name>`: Switch active profile without logging in.
- `--list`: List stored profiles.
- `--mode <background|manual>`: Set sync mode.
- `--no-prompt`: Skip the sync mode prompt.
- `--open`: Open the verification URL in a browser.

### `brag logout`

- `--profile <id>`: Remove a specific profile.
- `--all`: Remove all stored profiles.

### `brag sync`

- `--dump`: Print the first 20 aggregated entries.
- `--dump-all`: Print all aggregated entries.
- `--payload`: Print the full payload JSON.
- `--json`: Output machine-readable JSON.
- `--force`: Bypass rate limiting for uploads.
- `--local` / `--local-only`: Skip uploads and run locally.
- `--quiet`: Suppress output except errors.
- `--watch`: Run sync every 15 minutes with jitter.

### `brag status`

- `--json`: Output machine-readable JSON.
- `--debug`: Include extra diagnostic details.

### `brag config`

- `brag config list`: Print the full config.
- `brag config path`: Print the config file path.
- `brag config get <key>` / `set <key> <value>` / `unset <key>`.
- Keys: `syncMode`, `usagePath`, `apiBaseUrl`, `oauthClientId`, `oauthClientSecret`,
  `oauthDeviceUrl`, `oauthTokenUrl`, `oauthScopes`, `oauthAudience`, `localOnly`.

### `brag schedule`

- `status`: Show scheduler status.
- `enable`: Install background scheduler and set `syncMode=background`.
- `disable`: Remove scheduler and set `syncMode=manual`.
- `print`: Print the scheduler command and file paths.

## Configuration

Config keys are stored via `brag config` and can be overridden with env vars:

| Config key | Env var | Notes |
| --- | --- | --- |
| `apiBaseUrl` | `BRAG_API_BASE_URL` | Defaults to `https://usageleaderboard.com`. |
| `apiBaseUrl` | `BRAG_LOCAL_API` | Use `1`/`true` to force `http://localhost:4321`, or set a URL. |
| `oauthClientId` | `BRAG_OAUTH_CLIENT_ID` | Required for device login. |
| `oauthClientSecret` | `BRAG_OAUTH_CLIENT_SECRET` | Optional if provider allows. |
| `oauthDeviceUrl` | `BRAG_OAUTH_DEVICE_URL` | Override device code endpoint. |
| `oauthTokenUrl` | `BRAG_OAUTH_TOKEN_URL` | Override token endpoint. |
| `oauthScopes` | `BRAG_OAUTH_SCOPES` | Optional scope override. |
| `oauthAudience` | `BRAG_OAUTH_AUDIENCE` | Optional audience override. |
| `localOnly` | `BRAG_LOCAL_ONLY` | Force local-only mode. |

Config-only keys (no env override): `syncMode`, `usagePath`.

Additional env vars:

- `BRAG_API_SYNC_PATH`: Override the default `/v1/usage` sync path.
- `BRAG_API_TIMEOUT_MS`: Override API request timeout.
- `BRAG_API_TOKEN`: Token for `brag login --token`.
- `BRAG_AUTH_STORAGE`: Set to `file` to disable macOS keychain usage.
- `BRAG_SCHEDULER_NODE`: Override scheduler node path.
- `BRAG_SCHEDULER_ENTRY`: Override scheduler entry path.
- `BRAG_NO_PROMPT`: Skip interactive prompts during login.

## Troubleshooting

- "No usage files found": Set `usagePath` to the directory that contains Codex usage
  files (defaults to `~/.codex`).
- "Auth token missing or invalid": Run `brag login` again.
- "Auth rejected by API": Verify `apiBaseUrl` and re-authenticate.
- Rate limit warnings: Wait and retry, or use `brag sync --force`.
- Schedule enable fails: Run `brag schedule print` and check permissions.
- Need more detail: Run `brag status --debug` and inspect the log file in the
  config directory (`logs/brag.log`).

## Uninstall and cleanup

```bash
npm uninstall -g brag-sh
# or
bun remove -g brag-sh
```

To remove local data:

- Run `brag logout --all`.
- Delete the config directory:
  - macOS: `~/Library/Application Support/brag`
  - Linux: `${XDG_CONFIG_HOME:-~/.config}/brag`
  - Windows: `%APPDATA%\\brag`

## Build from source

```bash
cd cli
bun install
bun run build
node dist/index.js --help
```

## Support policy

- Runtime: Node.js >= 18.18.0 (required). Bun >= 1.2.0 (optional for dev/test).
- OS: macOS 12+, Windows 10/11, and modern Linux distros (Ubuntu 20.04+).
- Token storage: macOS keychain when available; encrypted file fallback elsewhere.
