import { afterEach, describe, expect, test } from "bun:test";

import {
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCodeResponse,
  type OAuthConfig,
} from "../src/lib/oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type MockResponse = {
  status: number;
  body: Record<string, unknown> | string;
};

function mockFetchSequence(responses: MockResponse[]): void {
  let index = 0;
  globalThis.fetch = async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const body =
      typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("OAuth device flow", () => {
  const config: OAuthConfig = {
    clientId: "brag-cli",
    deviceCodeUrl: "https://example.com/device",
    tokenUrl: "https://example.com/token",
  };

  test("requests a device code", async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          device_code: "device-code",
          user_code: "USER-CODE",
          verification_uri: "https://example.com/verify",
          expires_in: 120,
          interval: 1,
        },
      },
    ]);

    const response = await requestDeviceCode(config);
    expect(response.deviceCode).toBe("device-code");
    expect(response.userCode).toBe("USER-CODE");
    expect(response.verificationUri).toBe("https://example.com/verify");
  });

  test("polls until token is ready", async () => {
    const device: DeviceCodeResponse = {
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUri: "https://example.com/verify",
      expiresIn: 60,
      interval: 0,
    };

    mockFetchSequence([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: "token", token_type: "Bearer" } },
    ]);

    const token = await pollDeviceToken(config, device);
    expect(token.accessToken).toBe("token");
    expect(token.tokenType).toBe("Bearer");
  });

  test("surfaces access denied errors", async () => {
    const device: DeviceCodeResponse = {
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUri: "https://example.com/verify",
      expiresIn: 60,
      interval: 0,
    };

    mockFetchSequence([{ status: 400, body: { error: "access_denied" } }]);

    await expect(pollDeviceToken(config, device)).rejects.toThrow(
      "OAuth authorization was denied."
    );
  });
});
