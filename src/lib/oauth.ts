import type { Config } from "./config";

export type OAuthConfig = {
  clientId: string;
  clientSecret?: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scopes?: string;
  audience?: string;
};

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export type TokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
};

type OAuthError = {
  message: string;
  code?: string;
};

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function joinUrl(base: string, path: string): string {
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  const extraPath = path.startsWith("/") ? path : `/${path}`;
  baseUrl.pathname = `${basePath}${extraPath}`;
  return baseUrl.toString();
}

export function resolveOAuthConfig(config: Config): { ok: true; config: OAuthConfig } | { ok: false; error: string } {
  const apiBaseUrl = config.apiBaseUrl ?? process.env.BRAG_API_BASE_URL;
  const derivedDeviceCodeUrl = apiBaseUrl ? joinUrl(apiBaseUrl, "/v1/oauth/device/code") : undefined;
  const derivedTokenUrl = apiBaseUrl ? joinUrl(apiBaseUrl, "/v1/oauth/device/token") : undefined;

  const deviceCodeUrl =
    config.oauthDeviceUrl ?? process.env.BRAG_OAUTH_DEVICE_URL ?? derivedDeviceCodeUrl;
  const tokenUrl =
    config.oauthTokenUrl ?? process.env.BRAG_OAUTH_TOKEN_URL ?? derivedTokenUrl;

  const explicitClientId = config.oauthClientId ?? process.env.BRAG_OAUTH_CLIENT_ID;
  const clientId =
    explicitClientId ?? (deviceCodeUrl === derivedDeviceCodeUrl ? "brag-cli" : undefined);
  const scopes = config.oauthScopes ?? process.env.BRAG_OAUTH_SCOPES;
  const audience = config.oauthAudience ?? process.env.BRAG_OAUTH_AUDIENCE;
  const clientSecret = config.oauthClientSecret ?? process.env.BRAG_OAUTH_CLIENT_SECRET;

  if (!clientId) {
    return { ok: false, error: "OAuth client ID not configured (set oauthClientId or BRAG_OAUTH_CLIENT_ID)." };
  }
  if (!deviceCodeUrl) {
    return { ok: false, error: "OAuth device code URL not configured (set oauthDeviceUrl or apiBaseUrl)." };
  }
  if (!tokenUrl) {
    return { ok: false, error: "OAuth token URL not configured (set oauthTokenUrl or apiBaseUrl)." };
  }

  return {
    ok: true,
    config: {
      clientId,
      clientSecret: clientSecret || undefined,
      deviceCodeUrl,
      tokenUrl,
      scopes: scopes || undefined,
      audience: audience || undefined,
    },
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  let payload: Record<string, unknown> = { raw: text };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    payload = parsed;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const error = getString(payload.error) ?? `HTTP ${response.status}`;
    const description = getString(payload.error_description);
    const message = description ? `${error}: ${description}` : error;
    throw new Error(message);
  }

  return payload;
}

export async function requestDeviceCode(config: OAuthConfig): Promise<DeviceCodeResponse> {
  const payload: Record<string, string> = {
    client_id: config.clientId,
  };
  if (config.scopes) {
    payload.scope = config.scopes;
  }
  if (config.audience) {
    payload.audience = config.audience;
  }

  const response = await postForm(config.deviceCodeUrl, payload);
  const deviceCode = getString(response.device_code);
  const userCode = getString(response.user_code);
  const verificationUri = getString(response.verification_uri);
  const verificationUriComplete = getString(response.verification_uri_complete);
  const expiresIn = parseNumber(response.expires_in);
  const interval = parseNumber(response.interval) ?? 5;

  if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
    throw new Error("OAuth device code response missing required fields.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval,
  };
}

function parseTokenResponse(response: Record<string, unknown>): TokenResponse {
  const accessToken = getString(response.access_token);
  if (!accessToken) {
    throw new Error("OAuth token response missing access_token.");
  }
  return {
    accessToken,
    refreshToken: getString(response.refresh_token),
    tokenType: getString(response.token_type),
    scope: getString(response.scope),
    expiresIn: parseNumber(response.expires_in),
  };
}

function parseOAuthError(payload: Record<string, unknown>): OAuthError | null {
  const error = getString(payload.error);
  if (!error) {
    return null;
  }
  const description = getString(payload.error_description);
  return {
    code: error,
    message: description ? `${error}: ${description}` : error,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollDeviceToken(
  config: OAuthConfig,
  device: DeviceCodeResponse
): Promise<TokenResponse> {
  const expiresAt = Date.now() + device.expiresIn * 1000;
  let intervalMs = device.interval * 1000;

  while (Date.now() < expiresAt) {
    const body: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: config.clientId,
    };
    if (config.clientSecret) {
      body.client_secret = config.clientSecret;
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });

    const text = await response.text();
    let payload: Record<string, unknown> = { raw: text };
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { raw: text };
    }

    if (response.ok) {
      return parseTokenResponse(payload);
    }

    const oauthError = parseOAuthError(payload);
    if (!oauthError) {
      throw new Error(`OAuth token request failed with HTTP ${response.status}.`);
    }

    if (oauthError.code === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }

    if (oauthError.code === "slow_down") {
      intervalMs += 5_000;
      await sleep(intervalMs);
      continue;
    }

    if (oauthError.code === "access_denied") {
      throw new Error("OAuth authorization was denied.");
    }

    if (oauthError.code === "expired_token") {
      throw new Error("OAuth device code expired. Run login again.");
    }

    throw new Error(oauthError.message);
  }

  throw new Error("OAuth device code expired. Run login again.");
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string
): Promise<TokenResponse> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (config.clientSecret) {
    body.client_secret = config.clientSecret;
  }
  if (config.scopes) {
    body.scope = config.scopes;
  }

  const response = await postForm(config.tokenUrl, body);
  return parseTokenResponse(response);
}
