import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir } from "./config";

type DeviceState = {
  version: 1;
  deviceId: string;
  createdAt: string;
};

const DEVICE_FILE = "device.json";

function getDevicePath(): string {
  return join(getConfigDir(), DEVICE_FILE);
}

export function getOrCreateDeviceId(): string {
  const devicePath = getDevicePath();
  if (existsSync(devicePath)) {
    const raw = readFileSync(devicePath, "utf8");
    try {
      const parsed = JSON.parse(raw) as DeviceState;
      if (parsed?.deviceId && typeof parsed.deviceId === "string") {
        return parsed.deviceId;
      }
    } catch {
      throw new Error(`Invalid device JSON at ${devicePath}.`);
    }
  }

  const deviceId = randomUUID();
  const payload: DeviceState = {
    version: 1,
    deviceId,
    createdAt: new Date().toISOString(),
  };
  const dir = dirname(devicePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(devicePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return deviceId;
}
