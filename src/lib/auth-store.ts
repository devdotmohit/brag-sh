import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AuthProfile, AuthState } from "./auth-types";
import { getConfigDir } from "./config";

type AuthEnvelope = {
  version: 1;
  encrypted: true;
  iv: string;
  tag: string;
  ciphertext: string;
};

type ReadResult = {
  state: AuthState;
  exists: boolean;
  migrated: boolean;
};

const AUTH_FILE = "auth.json";
const KEY_FILE = "auth.key";
const KEYCHAIN_SERVICE = "brag-cli";
const KEYCHAIN_ACCOUNT = "auth-key";

const EMPTY_STATE: AuthState = {
  version: 1,
  profiles: {},
};

function getAuthPath(): string {
  return join(getConfigDir(), AUTH_FILE);
}

function getKeyPath(): string {
  return join(getConfigDir(), KEY_FILE);
}

function canUseKeychain(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const result = spawnSync("security", ["-h"], { encoding: "utf8" });
  return result.status === 0;
}

function readKeychainKey(): string | null {
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value ? value : null;
}

function writeKeychainKey(value: string): boolean {
  const result = spawnSync(
    "security",
    ["add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", value, "-U"],
    { encoding: "utf8" }
  );
  return result.status === 0;
}

function deleteKeychainKey(): void {
  spawnSync(
    "security",
    ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
    { encoding: "utf8" }
  );
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function normalizeKey(key: Buffer): Buffer {
  if (key.length === 32) {
    return key;
  }
  if (key.length > 32) {
    return key.subarray(0, 32);
  }
  throw new Error("Auth key is invalid.");
}

function loadKeyFromFile(allowCreate: boolean): Buffer {
  const keyPath = getKeyPath();
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8").trim();
    if (!raw) {
      throw new Error(`Auth key file is empty at ${keyPath}.`);
    }
    const decoded = Buffer.from(raw, "base64");
    return normalizeKey(decoded);
  }

  if (!allowCreate) {
    throw new Error(`Auth key file missing at ${keyPath}.`);
  }

  const key = randomBytes(32);
  ensureDir(dirname(keyPath));
  writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  return key;
}

function loadEncryptionKey(options: { allowCreate: boolean }): Buffer {
  const storage = process.env.BRAG_AUTH_STORAGE?.toLowerCase();
  const allowKeychain = storage !== "file";

  if (allowKeychain && canUseKeychain()) {
    const stored = readKeychainKey();
    if (stored) {
      return normalizeKey(Buffer.from(stored, "base64"));
    }
    if (!options.allowCreate) {
      throw new Error("Auth key missing from keychain.");
    }
    const key = randomBytes(32);
    if (writeKeychainKey(key.toString("base64"))) {
      return key;
    }
  }

  return loadKeyFromFile(options.allowCreate);
}

function encryptState(state: AuthState): AuthEnvelope {
  const key = loadEncryptionKey({ allowCreate: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = JSON.stringify(state);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    encrypted: true,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function decryptEnvelope(envelope: AuthEnvelope): AuthState {
  const key = loadEncryptionKey({ allowCreate: false });
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(decrypted.toString("utf8")) as AuthState;
  return coerceAuthState(parsed);
}

function isAuthEnvelope(value: unknown): value is AuthEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.encrypted === true && typeof record.ciphertext === "string";
}

function isLegacyAuth(value: unknown): value is { accessToken: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.accessToken === "string";
}

function coerceAuthState(value: AuthState): AuthState {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_STATE };
  }
  return {
    version: 1,
    activeProfileId: value.activeProfileId,
    profiles: value.profiles ?? {},
  };
}

function migrateLegacyAuth(record: Record<string, unknown>): AuthState {
  const now = new Date().toISOString();
  const accessToken = String(record.accessToken ?? "");
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : now;
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : undefined;
  const tokenType = typeof record.tokenType === "string" ? record.tokenType : "Bearer";

  const profile: AuthProfile = {
    id: "default",
    label: "default",
    provider: "x",
    token: {
      accessToken,
      tokenType,
      createdAt,
      expiresAt,
    },
    createdAt,
    updatedAt: createdAt,
  };

  return {
    version: 1,
    activeProfileId: profile.id,
    profiles: {
      [profile.id]: profile,
    },
  };
}

export function readAuthState(): ReadResult {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) {
    return { state: { ...EMPTY_STATE }, exists: false, migrated: false };
  }

  const raw = readFileSync(authPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid auth JSON at ${authPath}.`);
  }

  if (isAuthEnvelope(parsed)) {
    return {
      state: decryptEnvelope(parsed),
      exists: true,
      migrated: false,
    };
  }

  if (isLegacyAuth(parsed)) {
    return {
      state: migrateLegacyAuth(parsed as Record<string, unknown>),
      exists: true,
      migrated: true,
    };
  }

  return {
    state: coerceAuthState(parsed as AuthState),
    exists: true,
    migrated: true,
  };
}

export function writeAuthState(state: AuthState): void {
  const authPath = getAuthPath();
  ensureDir(dirname(authPath));
  const envelope = encryptState(state);
  const payload = JSON.stringify(envelope, null, 2);
  writeFileSync(authPath, `${payload}\n`, { mode: 0o600 });
}

export function clearAuthState(): boolean {
  const authPath = getAuthPath();
  let removed = false;
  if (existsSync(authPath)) {
    unlinkSync(authPath);
    removed = true;
  }
  const keyPath = getKeyPath();
  if (existsSync(keyPath)) {
    unlinkSync(keyPath);
  }
  if (canUseKeychain()) {
    deleteKeychainKey();
  }
  return removed;
}
