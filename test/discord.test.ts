import { describe, expect, it } from "vitest";

import { app } from "../src/app";

const encoder = new TextEncoder();

const toHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const createSignedDiscordRequest = async (payload: unknown) => {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = (await crypto.subtle.exportKey(
    "raw",
    keyPair.publicKey,
  )) as ArrayBuffer;
  const body = JSON.stringify(payload);
  const timestamp = "1712131200";
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keyPair.privateKey,
    encoder.encode(`${timestamp}${body}`),
  );

  return {
    body,
    env: {
      DB: {} as D1Database,
      DISCORD_PUBLIC_KEY: toHex(publicKey),
    },
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": toHex(signature),
      "x-signature-timestamp": timestamp,
    },
  };
};

describe("discord interactions", () => {
  it("rejects unsigned requests", async () => {
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: 1 }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "DISCORD_PUBLIC_KEY is not configured.",
    });
  });

  it("responds to Discord ping interactions", async () => {
    const request = await createSignedDiscordRequest({ type: 1 });
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      request.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("dispatches known slash commands", async () => {
    const request = await createSignedDiscordRequest({
      type: 2,
      data: {
        name: "start",
      },
    });
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      request.env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      type: 4,
      data: {
        content: "デフォルト設定でのバチャ作成は未実装です。",
      },
    });
  });
});
