import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { getConfigDir } from "./config";

type DeviceStateV1 = {
  version: 1;
  deviceId: string;
  createdAt: string;
};

type DeviceStateV2 = {
  version: 2;
  deviceId: string;
  deviceName: string;
  createdAt: string;
};

type DeviceState = DeviceStateV1 | DeviceStateV2;

const DEVICE_FILE = "device.json";
const DEVICE_NAME_MAX = 128;
const DEFAULT_DEVICE_NAME = "unknown";

function getDevicePath(): string {
  return join(getConfigDir(), DEVICE_FILE);
}

function normalizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > DEVICE_NAME_MAX) {
    return trimmed.slice(0, DEVICE_NAME_MAX);
  }
  return trimmed;
}

function resolveDeviceName(): string {
  return normalizeDeviceName(hostname()) ?? DEFAULT_DEVICE_NAME;
}

function writeDeviceState(devicePath: string, payload: DeviceStateV2): void {
  const dir = dirname(devicePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(devicePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export function getOrCreateDeviceInfo(): { deviceId: string; deviceName: string } {
  const devicePath = getDevicePath();
  if (existsSync(devicePath)) {
    const raw = readFileSync(devicePath, "utf8");
    try {
      const parsed = JSON.parse(raw) as DeviceState;
      if (parsed?.deviceId && typeof parsed.deviceId === "string") {
        const parsedDeviceName = normalizeDeviceName((parsed as DeviceStateV2).deviceName);
        const deviceName = parsedDeviceName ?? resolveDeviceName();
        const createdAt =
          typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString();
        if (parsed.version !== 2 || !parsedDeviceName) {
          writeDeviceState(devicePath, {
            version: 2,
            deviceId: parsed.deviceId,
            deviceName,
            createdAt,
          });
        }
        return { deviceId: parsed.deviceId, deviceName };
      }
    } catch {
      throw new Error(`Invalid device JSON at ${devicePath}.`);
    }
  }

  const deviceId = randomUUID();
  const deviceName = resolveDeviceName();
  const payload: DeviceStateV2 = {
    version: 2,
    deviceId,
    deviceName,
    createdAt: new Date().toISOString(),
  };
  writeDeviceState(devicePath, payload);
  return { deviceId, deviceName };
}

export function getOrCreateDeviceId(): string {
  return getOrCreateDeviceInfo().deviceId;
}
