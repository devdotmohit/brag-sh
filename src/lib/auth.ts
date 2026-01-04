import type { AuthProfile, AuthState, AuthToken } from "./auth-types";
import { readAuthState, writeAuthState, clearAuthState } from "./auth-store";
import { readConfig } from "./config";
import { logEvent } from "./logger";
import { refreshAccessToken, resolveOAuthConfig } from "./oauth";

export type AuthResolution = {
  status: "missing" | "valid" | "expired" | "refresh_failed";
  token?: string;
  tokenType?: string;
  source?: "env" | "store";
  profileId?: string;
  profileLabel?: string;
  expiresAt?: string;
  refreshable?: boolean;
  message?: string;
  lastError?: AuthProfile["lastError"];
};

export type AuthProfileSummary = {
  id: string;
  label: string;
  provider: string;
  isActive: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
};

const DEFAULT_TOKEN_TYPE = "Bearer";
const DEFAULT_PROFILE_ID = "default";
const EXPIRY_SKEW_MS = 60_000;

function normalizeProfileId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || DEFAULT_PROFILE_ID;
}

function ensureActiveProfile(state: AuthState): AuthState {
  if (state.activeProfileId) {
    return state;
  }
  const ids = Object.keys(state.profiles);
  if (ids.length === 0) {
    return state;
  }
  return { ...state, activeProfileId: ids[0] };
}

function loadAuthState(): AuthState {
  const { state, migrated } = readAuthState();
  const normalized = ensureActiveProfile(state);
  if (migrated || normalized !== state) {
    writeAuthState(normalized);
  }
  return normalized;
}

function writeState(state: AuthState): void {
  writeAuthState(state);
}

function isExpired(token: AuthToken, now: Date): boolean {
  if (!token.expiresAt) {
    return false;
  }
  const expires = Date.parse(token.expiresAt);
  if (Number.isNaN(expires)) {
    return false;
  }
  return now.getTime() >= expires - EXPIRY_SKEW_MS;
}

function getActiveProfile(state: AuthState): AuthProfile | undefined {
  const active = state.activeProfileId;
  if (!active) {
    return undefined;
  }
  return state.profiles[active];
}

function touchProfile(state: AuthState, profileId: string, updates: Partial<AuthProfile>): void {
  const profile = state.profiles[profileId];
  if (!profile) {
    return;
  }
  state.profiles[profileId] = {
    ...profile,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

export function listAuthProfiles(): AuthProfileSummary[] {
  let state: AuthState;
  try {
    state = loadAuthState();
  } catch (error) {
    return {
      status: "missing",
      message: error instanceof Error ? error.message : "Auth state unavailable.",
    };
  }
  const active = state.activeProfileId;
  return Object.values(state.profiles).map((profile) => ({
    id: profile.id,
    label: profile.label,
    provider: profile.provider,
    isActive: profile.id === active,
    expiresAt: profile.token.expiresAt,
    lastUsedAt: profile.lastUsedAt,
  }));
}

export function setActiveProfile(profileId: string): { ok: boolean; message?: string } {
  let state: AuthState;
  try {
    state = loadAuthState();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Auth state unavailable.";
    return { status: "missing", message };
  }
  if (!state.profiles[profileId]) {
    const normalized = normalizeProfileId(profileId);
    if (!state.profiles[normalized]) {
      return { ok: false, message: `No profile named ${profileId}.` };
    }
    state.activeProfileId = normalized;
  } else {
    state.activeProfileId = profileId;
  }
  writeState(state);
  return { ok: true };
}

export function upsertAuthProfile(params: {
  profileId?: string;
  label?: string;
  provider?: AuthProfile["provider"];
  account?: AuthProfile["account"];
  token: AuthToken;
}): AuthProfile {
  const state = loadAuthState();
  const desiredId = params.profileId ?? params.label ?? state.activeProfileId ?? DEFAULT_PROFILE_ID;
  const profileId = normalizeProfileId(desiredId);
  const label = params.label ?? profileId;
  const now = new Date().toISOString();
  const existing = state.profiles[profileId];

  const profile: AuthProfile = {
    id: profileId,
    label,
    provider: params.provider ?? existing?.provider ?? "x",
    account: params.account ?? existing?.account,
    token: params.token,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
  };

  state.profiles[profileId] = {
    ...profile,
    lastError: undefined,
  };
  state.activeProfileId = profileId;
  writeState(state);
  logEvent("info", "auth.profile.updated", {
    profileId,
    label,
    provider: profile.provider,
    refreshable: Boolean(profile.token.refreshToken),
    expiresAt: profile.token.expiresAt,
  });
  return state.profiles[profileId];
}

export function removeAuthProfile(profileId: string): { removed: boolean; remaining: number } {
  const state = loadAuthState();
  const normalized = state.profiles[profileId] ? profileId : normalizeProfileId(profileId);
  if (!state.profiles[normalized]) {
    return { removed: false, remaining: Object.keys(state.profiles).length };
  }
  delete state.profiles[normalized];
  if (state.activeProfileId === normalized) {
    state.activeProfileId = Object.keys(state.profiles)[0];
  }
  writeState(state);
  return { removed: true, remaining: Object.keys(state.profiles).length };
}

export function clearAuth(): boolean {
  return clearAuthState();
}

export function recordAuthError(profileId: string, message: string, code?: string): void {
  const state = loadAuthState();
  if (!state.profiles[profileId]) {
    return;
  }
  touchProfile(state, profileId, {
    lastError: {
      message,
      code,
      at: new Date().toISOString(),
    },
  });
  writeState(state);
  logEvent("warn", "auth.error", { profileId, code, message });
}

export function getAuthStatus(now = new Date()): AuthResolution {
  const envToken = process.env.BRAG_API_TOKEN;
  if (envToken && envToken.trim()) {
    return {
      status: "valid",
      tokenType: DEFAULT_TOKEN_TYPE,
      source: "env",
      refreshable: false,
    };
  }

  const state = loadAuthState();
  const profile = getActiveProfile(state);
  if (!profile) {
    return { status: "missing", message: "No auth profile configured." };
  }
  const expired = isExpired(profile.token, now);
  return {
    status: expired ? "expired" : "valid",
    tokenType: profile.token.tokenType ?? DEFAULT_TOKEN_TYPE,
    source: "store",
    profileId: profile.id,
    profileLabel: profile.label,
    expiresAt: profile.token.expiresAt,
    refreshable: Boolean(profile.token.refreshToken),
    lastError: profile.lastError,
    message: expired ? "Auth token expired. Run brag login." : undefined,
  };
}

export async function resolveAuthToken(options?: {
  allowRefresh?: boolean;
  now?: Date;
}): Promise<AuthResolution> {
  const envToken = process.env.BRAG_API_TOKEN;
  if (envToken && envToken.trim()) {
    return {
      status: "valid",
      token: envToken.trim(),
      tokenType: DEFAULT_TOKEN_TYPE,
      source: "env",
      refreshable: false,
    };
  }

  const now = options?.now ?? new Date();
  const state = loadAuthState();
  const profile = getActiveProfile(state);
  if (!profile) {
    return { status: "missing", message: "No auth profile configured." };
  }

  const expired = isExpired(profile.token, now);
  if (!expired) {
    touchProfile(state, profile.id, { lastUsedAt: now.toISOString(), lastError: undefined });
    writeState(state);
    return {
      status: "valid",
      token: profile.token.accessToken,
      tokenType: profile.token.tokenType ?? DEFAULT_TOKEN_TYPE,
      source: "store",
      profileId: profile.id,
      profileLabel: profile.label,
      expiresAt: profile.token.expiresAt,
      refreshable: Boolean(profile.token.refreshToken),
      lastError: profile.lastError,
    };
  }

  if (!options?.allowRefresh || !profile.token.refreshToken) {
    return {
      status: "expired",
      source: "store",
      profileId: profile.id,
      profileLabel: profile.label,
      expiresAt: profile.token.expiresAt,
      refreshable: Boolean(profile.token.refreshToken),
      lastError: profile.lastError,
      message: "Auth token expired. Run brag login.",
    };
  }

  let config;
  try {
    ({ config } = readConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAuthError(profile.id, message);
    return { status: "refresh_failed", message, profileId: profile.id, profileLabel: profile.label };
  }

  const oauth = resolveOAuthConfig(config);
  if (!oauth.ok) {
    recordAuthError(profile.id, oauth.error);
    return { status: "refresh_failed", message: oauth.error, profileId: profile.id, profileLabel: profile.label };
  }

  try {
    const refreshed = await refreshAccessToken(oauth.config, profile.token.refreshToken);
    const createdAt = now.toISOString();
    const expiresAt =
      refreshed.expiresIn !== undefined
        ? new Date(now.getTime() + refreshed.expiresIn * 1000).toISOString()
        : profile.token.expiresAt;

    const updatedToken: AuthToken = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? profile.token.refreshToken,
      tokenType: refreshed.tokenType ?? profile.token.tokenType ?? DEFAULT_TOKEN_TYPE,
      scope: refreshed.scope ?? profile.token.scope,
      createdAt,
      expiresAt,
    };

    touchProfile(state, profile.id, {
      token: updatedToken,
      lastUsedAt: createdAt,
      lastError: undefined,
    });
    writeState(state);
    logEvent("info", "auth.refresh.success", {
      profileId: profile.id,
      expiresAt: updatedToken.expiresAt,
    });

    return {
      status: "valid",
      token: updatedToken.accessToken,
      tokenType: updatedToken.tokenType ?? DEFAULT_TOKEN_TYPE,
      source: "store",
      profileId: profile.id,
      profileLabel: profile.label,
      expiresAt: updatedToken.expiresAt,
      refreshable: Boolean(updatedToken.refreshToken),
      lastError: undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Auth refresh failed.";
    recordAuthError(profile.id, message);
    return {
      status: "refresh_failed",
      source: "store",
      profileId: profile.id,
      profileLabel: profile.label,
      expiresAt: profile.token.expiresAt,
      refreshable: Boolean(profile.token.refreshToken),
      lastError: profile.lastError,
      message,
    };
  }
}
