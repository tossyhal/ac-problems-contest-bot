import { describe, expect, it } from "vitest";

import { app } from "../src/app";

const encoder = new TextEncoder();

const toHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const createMockDatabase = () => {
  let settingRecord: null | Record<string, unknown> = null;
  let difficultyBandRecords: Record<string, unknown>[] = [];

  return {
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (
            query.includes("FROM sync_states") &&
            params[0] === "submissions"
          ) {
            return null;
          }

          return null;
        },
        run: async () => {
          if (query.includes("INSERT INTO settings")) {
            settingRecord = {
              atcoder_user_id: params[1],
              default_slot_minutes: params[2],
              default_problem_count: params[3],
              default_contest_duration_minutes: params[4],
              default_penalty_seconds: params[5],
              include_experimental_difficulty: params[6],
              include_abc: params[7],
              include_arc: params[8],
              include_agc: params[9],
              allow_other_sources: params[10],
              exclude_recently_used_days: params[11],
              visibility: params[12],
              title_template: params[13],
              memo_template: params[14],
            };
          }

          if (query.includes("DELETE FROM setting_difficulty_bands")) {
            difficultyBandRecords = [];
          }

          if (query.includes("INSERT INTO setting_difficulty_bands")) {
            difficultyBandRecords.push({
              setting_id: params[0],
              sort_order: params[1],
              difficulty_min: params[2],
              difficulty_max: params[3],
              problem_count: params[4],
            });
          }

          return { success: true };
        },
      }),
      first: async () => {
        if (query.includes("FROM settings")) {
          return settingRecord;
        }

        return null;
      },
      all: async () => {
        if (query.includes("FROM setting_difficulty_bands")) {
          return { results: difficultyBandRecords };
        }

        return { results: [] };
      },
    }),
  } as unknown as D1Database;
};

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
      DB: createMockDatabase(),
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

  it("shows current settings from D1 defaults", async () => {
    const request = await createSignedDiscordRequest({
      type: 2,
      data: {
        name: "setting",
        options: [
          {
            name: "action",
            type: 3,
            value: "show",
          },
        ],
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
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("現在のデフォルト設定:");
    expect(body.data.content).toContain("AtCoder user ID: 未設定");
    expect(body.data.content).toContain("難易度帯: 未設定");
  });

  it("shows current sync status from D1 defaults", async () => {
    const request = await createSignedDiscordRequest({
      type: 2,
      data: {
        name: "init",
        options: [
          {
            name: "action",
            type: 3,
            value: "status",
          },
        ],
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
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("現在の同期状態:");
    expect(body.data.content).toContain("status: idle");
    expect(body.data.content).toContain("last error: なし");
  });

  it("updates settings and shows persisted values", async () => {
    const request = await createSignedDiscordRequest({
      type: 2,
      data: {
        name: "setting",
        options: [
          {
            name: "action",
            type: 3,
            value: "update",
          },
          {
            name: "atcoder-user-id",
            type: 3,
            value: "tossyhal",
          },
          {
            name: "contest-minutes",
            type: 4,
            value: 120,
          },
          {
            name: "include-abc",
            type: 5,
            value: false,
          },
          {
            name: "difficulty-bands",
            type: 3,
            value: "800-999:2,1000-1199:3",
          },
        ],
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
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("デフォルト設定を更新しました。");
    expect(body.data.content).toContain("AtCoder user ID: tossyhal");
    expect(body.data.content).toContain("コンテスト時間: 120分");
    expect(body.data.content).toContain("ABC=OFF");
    expect(body.data.content).toContain(
      "難易度帯: 800-999: 2問, 1000-1199: 3問",
    );
  });
});
