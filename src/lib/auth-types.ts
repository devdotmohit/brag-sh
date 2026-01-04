export type AuthToken = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  createdAt: string;
  expiresAt?: string;
};

export type AuthError = {
  message: string;
  at: string;
  code?: string;
};

export type AuthProfile = {
  id: string;
  label: string;
  provider: "x";
  account?: {
    id?: string;
    handle?: string;
  };
  token: AuthToken;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastError?: AuthError;
};

export type AuthState = {
  version: 1;
  activeProfileId?: string;
  profiles: Record<string, AuthProfile>;
};
