import { afterEach, describe, expect, it, vi } from "vitest";

import { app } from "../src/app";

const encoder = new TextEncoder();

const toHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const createSha256Hex = async (value: string) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const createMockDatabase = (
  seed: {
    commandLogRecords?: Record<string, unknown>[];
    contestRunRecords?: Record<string, unknown>[];
    difficultyBandRecords?: Record<string, unknown>[];
    problemCatalogRecords?: Record<string, unknown>[];
    problemUsageLogRecords?: Record<string, unknown>[];
    settingRecord?: null | Record<string, unknown>;
    solvedProblemRecords?: Record<string, unknown>[];
    syncStateRecords?: Record<string, Record<string, unknown> | null>;
  } = {},
) => {
  let settingRecord: null | Record<string, unknown> =
    seed.settingRecord ?? null;
  let difficultyBandRecords = [...(seed.difficultyBandRecords ?? [])];
  const syncStateRecords: Record<string, Record<string, unknown> | null> = {
    ...(seed.syncStateRecords ?? {}),
  };
  let solvedProblemRecords = [...(seed.solvedProblemRecords ?? [])];
  const problemCatalogRecords = [...(seed.problemCatalogRecords ?? [])];
  const problemUsageLogRecords = [...(seed.problemUsageLogRecords ?? [])];
  const contestRunRecords = [...(seed.contestRunRecords ?? [])];
  const commandLogRecords = [...(seed.commandLogRecords ?? [])];

  return {
    __state: {
      commandLogRecords,
      contestRunRecords,
    },
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      for (const statement of statements) {
        await statement.run();
      }

      return [];
    },
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (query.includes("FROM sync_states")) {
            return syncStateRecords[String(params[0])] ?? null;
          }

          if (query.includes("FROM contest_runs")) {
            return (
              contestRunRecords.find(
                (record) =>
                  record.request_fingerprint === params[0] &&
                  record.status === "completed",
              ) ?? null
            );
          }

          return null;
        },
        all: async () => {
          if (query.includes("FROM solved_problems")) {
            return { results: solvedProblemRecords };
          }

          if (query.includes("FROM problem_usage_logs")) {
            return {
              results: problemUsageLogRecords.filter(
                (record) => Number(record.used_at) >= Number(params[0]),
              ),
            };
          }

          return { results: [] };
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

          if (query.includes("INSERT INTO sync_states")) {
            syncStateRecords[String(params[0])] = {
              status: params[1],
              full_sync_completed_at: params[2],
              last_synced_at: params[3],
              last_checkpoint: params[4],
              last_success_checkpoint: params[5],
              last_error: params[6],
            };
          }

          if (query.includes("INSERT INTO solved_problems")) {
            solvedProblemRecords = solvedProblemRecords.filter(
              (record) =>
                !(
                  record.atcoder_user_id === params[0] &&
                  record.problem_id === params[1]
                ),
            );
            solvedProblemRecords.push({
              atcoder_user_id: params[0],
              problem_id: params[1],
              solved_at: params[2],
              synced_at: params[3],
            });
          }

          if (query.includes("INSERT INTO contest_runs")) {
            const nextId = contestRunRecords.length + 1;
            contestRunRecords.push({
              id: nextId,
              request_fingerprint: params[0],
              dedupe_key: params[1],
              status: params[2],
              started_at: params[3],
            });

            return {
              meta: {
                last_row_id: nextId,
              },
              success: true,
            };
          }

          if (query.includes("UPDATE contest_runs")) {
            const contestRun = contestRunRecords.find(
              (record) => record.id === params[4],
            );

            if (contestRun) {
              contestRun.status = params[0];
              contestRun.contest_url = params[1];
              contestRun.contest_id = params[2];
              contestRun.error_message = params[3];
            }
          }

          if (query.includes("INSERT INTO problem_usage_logs")) {
            problemUsageLogRecords.push({
              contest_run_id: params[2],
              problem_id: params[0],
              used_at: params[1],
            });
          }

          if (query.includes("INSERT INTO command_logs")) {
            commandLogRecords.push({
              command_context: params[1],
              command_name: params[0],
              message: params[4],
              settings_summary: params[3],
              status: params[2],
            });
          }

          return { success: true };
        },
      }),
      first: async () => {
        if (query.includes("FROM settings")) {
          return settingRecord;
        }

        if (query.includes("FROM sync_states")) {
          return syncStateRecords.submissions ?? null;
        }

        if (query.includes("COUNT(*) AS count FROM problem_catalog")) {
          return { count: problemCatalogRecords.length };
        }

        return null;
      },
      all: async () => {
        if (query.includes("FROM setting_difficulty_bands")) {
          return { results: difficultyBandRecords };
        }

        if (query.includes("FROM solved_problems")) {
          return { results: solvedProblemRecords };
        }

        if (query.includes("FROM problem_catalog")) {
          return { results: problemCatalogRecords };
        }

        return { results: [] };
      },
    }),
  } as unknown as D1Database;
};

const createSignedDiscordRequest = async (
  payload: unknown,
  database: D1Database = createMockDatabase(),
) => {
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
      DB: database,
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
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
        content:
          "AtCoder user ID が未設定です。/setting action:update で atcoder-user-id を設定してください。",
      },
    });
  });

  it("creates contest from selected problems on start", async () => {
    const database = createMockDatabase({
      problemCatalogRecords: [
        {
          contest_id: "abc100",
          difficulty: 850,
          is_experimental: 0,
          problem_id: "abc100_a",
          problem_index: "A",
          source_category: "ABC",
          title: "A",
        },
        {
          contest_id: "abc100",
          difficulty: 920,
          is_experimental: 0,
          problem_id: "abc100_b",
          problem_index: "B",
          source_category: "ABC",
          title: "B",
        },
      ],
      settingRecord: {
        allow_other_sources: 0,
        atcoder_user_id: "tossyhal",
        default_contest_duration_minutes: 100,
        default_penalty_seconds: 300,
        default_problem_count: 2,
        default_slot_minutes: 5,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 0,
        include_experimental_difficulty: 0,
        memo_template: null,
        title_template: null,
        visibility: "private",
      },
      syncStateRecords: {
        problem_catalog: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "2",
          last_error: null,
          last_success_checkpoint: "2",
          last_synced_at: Date.now(),
          status: "completed",
        },
        submissions: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "123",
          last_error: null,
          last_success_checkpoint: "123",
          last_synced_at: Date.now(),
          status: "completed",
        },
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/atcoder-api/v3/user/submissions")) {
        return Response.json([]);
      }

      if (url.endsWith("/internal-api/contest/create")) {
        return Response.json({
          contest_id: "contest-123",
        });
      }

      if (url.endsWith("/internal-api/contest/item/update")) {
        return new Response(null, {
          status: 200,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "start",
        },
      },
      database,
    );
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        ...request.env,
        ATCODER_PROBLEMS_TOKEN: "test-token",
      },
    );
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain(
      "https://kenkoooo.com/atcoder/#/contest/show/contest-123",
    );
    expect(body.data.content).toContain("バチャを作成しました。");
    expect(body.data.content).toContain("開始時刻:");
  }, 10000);

  it("reuses existing contest URL when the same fingerprint already completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T11:01:00.000Z"));
    const startEpochSecond = Math.floor(
      new Date("2026-04-03T11:05:00.000Z").getTime() / 1000,
    );
    const requestFingerprint = await createSha256Hex(
      JSON.stringify({
        difficultyBands: [],
        problemIds: ["abc100_a"],
        startEpochSecond,
        visibility: "private",
      }),
    );
    const database = createMockDatabase({
      contestRunRecords: [
        {
          contest_id: "contest-123",
          contest_url:
            "https://kenkoooo.com/atcoder/#/contest/show/contest-123",
          id: 1,
          request_fingerprint: requestFingerprint,
          status: "completed",
        },
      ],
      problemCatalogRecords: [
        {
          contest_id: "abc100",
          difficulty: 850,
          is_experimental: 0,
          problem_id: "abc100_a",
          problem_index: "A",
          source_category: "ABC",
          title: "A",
        },
      ],
      settingRecord: {
        allow_other_sources: 0,
        atcoder_user_id: "tossyhal",
        default_contest_duration_minutes: 100,
        default_penalty_seconds: 300,
        default_problem_count: 1,
        default_slot_minutes: 5,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 0,
        include_experimental_difficulty: 0,
        memo_template: null,
        title_template: null,
        visibility: "private",
      },
      syncStateRecords: {
        problem_catalog: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "2",
          last_error: null,
          last_success_checkpoint: "2",
          last_synced_at: Date.now(),
          status: "completed",
        },
        submissions: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "123",
          last_error: null,
          last_success_checkpoint: "123",
          last_synced_at: Date.now(),
          status: "completed",
        },
      },
    });
    let createCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/atcoder-api/v3/user/submissions")) {
        return Response.json([]);
      }

      if (url.endsWith("/internal-api/contest/create")) {
        createCalls += 1;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "start",
        },
      },
      database,
    );
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        ...request.env,
        ATCODER_PROBLEMS_TOKEN: "test-token",
      },
    );
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("既存のバチャを再利用しました。");
    expect(body.data.content).toContain(
      "https://kenkoooo.com/atcoder/#/contest/show/contest-123",
    );
    expect(createCalls).toBe(0);
  });

  it("queues incremental submission sync before start when more pages remain", async () => {
    const database = createMockDatabase({
      problemCatalogRecords: [
        {
          contest_id: "abc100",
          difficulty: 850,
          is_experimental: 0,
          problem_id: "abc100_a",
          problem_index: "A",
          source_category: "ABC",
          title: "A",
        },
      ],
      settingRecord: {
        allow_other_sources: 0,
        atcoder_user_id: "tossyhal",
        default_contest_duration_minutes: 100,
        default_penalty_seconds: 300,
        default_problem_count: 1,
        default_slot_minutes: 5,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 0,
        include_experimental_difficulty: 0,
        memo_template: null,
        title_template: null,
        visibility: "private",
      },
      syncStateRecords: {
        problem_catalog: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "2",
          last_error: null,
          last_success_checkpoint: "2",
          last_synced_at: Date.now(),
          status: "completed",
        },
        submissions: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "123",
          last_error: null,
          last_success_checkpoint: "123",
          last_synced_at: Date.now(),
          status: "completed",
        },
      },
    });
    let startRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/atcoder-api/v3/user/submissions")) {
        return Response.json(
          Array.from({ length: 500 }, (_, index) => ({
            epoch_second: 1712131200 + index,
            id: index + 1,
            problem_id: `abc100_${index}`,
            result: "AC",
          })),
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "start",
        },
      },
      database,
    );
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        ...request.env,
        ATCODER_PROBLEMS_TOKEN: "test-token",
        SUBMISSION_SYNC: {
          get: () => ({
            fetch: async () => {
              startRequests += 1;

              return Response.json({
                status: "queued",
              });
            },
          }),
          idFromName: () => "submission-sync-id",
        } as unknown as DurableObjectNamespace,
      },
    );
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("提出情報の増分同期を開始しました。");
    expect(startRequests).toBe(1);
  });

  it("writes a failed command log when durable object transport fails", async () => {
    const database = createMockDatabase({
      problemCatalogRecords: [
        {
          contest_id: "abc100",
          difficulty: 850,
          is_experimental: 0,
          problem_id: "abc100_a",
          problem_index: "A",
          source_category: "ABC",
          title: "A",
        },
      ],
      settingRecord: {
        allow_other_sources: 0,
        atcoder_user_id: "tossyhal",
        default_contest_duration_minutes: 100,
        default_penalty_seconds: 300,
        default_problem_count: 1,
        default_slot_minutes: 5,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 0,
        include_experimental_difficulty: 0,
        memo_template: null,
        title_template: null,
        visibility: "private",
      },
      syncStateRecords: {
        problem_catalog: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "2",
          last_error: null,
          last_success_checkpoint: "2",
          last_synced_at: Date.now(),
          status: "completed",
        },
        submissions: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "123",
          last_error: null,
          last_success_checkpoint: "123",
          last_synced_at: Date.now(),
          status: "completed",
        },
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/atcoder-api/v3/user/submissions")) {
        return Response.json([]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "start",
        },
      },
      database,
    );
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        ...request.env,
        ATCODER_PROBLEMS_TOKEN: "test-token",
        CONTEST_CREATION_GUARD: {
          get: () => ({
            fetch: async () => {
              throw new Error("durable object transport failed");
            },
          }),
          idFromName: () => "contest-creation-guard-id",
        } as unknown as DurableObjectNamespace,
      },
    );
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("durable object transport failed");
    expect(
      (
        database as unknown as {
          __state: { commandLogRecords: Array<Record<string, unknown>> };
        }
      ).__state.commandLogRecords,
    ).toContainEqual(
      expect.objectContaining({
        command_name: "start",
        message: "durable object transport failed",
        status: "failed",
      }),
    );
  });

  it("marks submission sync failed when incremental sync handoff to DO fails", async () => {
    const database = createMockDatabase({
      problemCatalogRecords: [
        {
          contest_id: "abc100",
          difficulty: 850,
          is_experimental: 0,
          problem_id: "abc100_a",
          problem_index: "A",
          source_category: "ABC",
          title: "A",
        },
      ],
      settingRecord: {
        allow_other_sources: 0,
        atcoder_user_id: "tossyhal",
        default_contest_duration_minutes: 100,
        default_penalty_seconds: 300,
        default_problem_count: 1,
        default_slot_minutes: 5,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 0,
        include_experimental_difficulty: 0,
        memo_template: null,
        title_template: null,
        visibility: "private",
      },
      syncStateRecords: {
        problem_catalog: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "2",
          last_error: null,
          last_success_checkpoint: "2",
          last_synced_at: Date.now(),
          status: "completed",
        },
        submissions: {
          full_sync_completed_at: Date.now(),
          last_checkpoint: "123",
          last_error: null,
          last_success_checkpoint: "123",
          last_synced_at: Date.now(),
          status: "completed",
        },
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/atcoder-api/v3/user/submissions")) {
        return Response.json(
          Array.from({ length: 500 }, (_, index) => ({
            epoch_second: 1712131200 + index,
            id: index + 1,
            problem_id: `abc100_${index}`,
            result: "AC",
          })),
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "start",
        },
      },
      database,
    );
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        ...request.env,
        ATCODER_PROBLEMS_TOKEN: "test-token",
        SUBMISSION_SYNC: {
          get: () => ({
            fetch: async () => {
              throw new Error("submission sync handoff failed");
            },
          }),
          idFromName: () => "submission-sync-id",
        } as unknown as DurableObjectNamespace,
      },
    );
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("提出同期ジョブの開始に失敗しました。");
    expect(body.data.content).toContain("submission sync handoff failed");
    await expect(
      (
        database as unknown as {
          prepare: (query: string) => {
            bind: (...params: unknown[]) => { first: () => Promise<unknown> };
          };
        }
      )
        .prepare(
          `SELECT
            status,
            full_sync_completed_at,
            last_synced_at,
            last_checkpoint,
            last_success_checkpoint,
            last_error
          FROM sync_states
          WHERE scope = ?`,
        )
        .bind("submissions")
        .first(),
    ).resolves.toEqual(
      expect.objectContaining({
        last_error: "submission sync handoff failed",
        status: "failed",
      }),
    );
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

  it("runs init and persists sync status", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 1,
              epoch_second: 1712131200,
              problem_id: "abc100_a",
              result: "AC",
            },
            {
              id: 2,
              epoch_second: 1712131201,
              problem_id: "abc100_b",
              result: "WA",
            },
          ]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
    );
    const database = createMockDatabase();
    const updateRequest = await createSignedDiscordRequest(
      {
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
          ],
        },
      },
      database,
    );
    await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: updateRequest.headers,
        body: updateRequest.body,
      },
      updateRequest.env,
    );
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "init",
          options: [
            {
              name: "action",
              type: 3,
              value: "run",
            },
          ],
        },
      },
      database,
    );
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
    expect(body.data.content).toContain("初期同期を完了しました。");
    expect(body.data.content).toContain("status: completed");
    expect(body.data.content).toContain("last checkpoint: 1712131201");
  });

  it("queues init when submission sync durable object is available", async () => {
    const database = createMockDatabase();
    let startRequests = 0;
    const updateRequest = await createSignedDiscordRequest(
      {
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
          ],
        },
      },
      database,
    );
    await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: updateRequest.headers,
        body: updateRequest.body,
      },
      updateRequest.env,
    );
    const request = await createSignedDiscordRequest(
      {
        type: 2,
        data: {
          name: "init",
          options: [
            {
              name: "action",
              type: 3,
              value: "run",
            },
          ],
        },
      },
      database,
    );
    const response = await app.request(
      "http://localhost/discord/interactions",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        ...request.env,
        SUBMISSION_SYNC: {
          get: () => ({
            fetch: async () => {
              startRequests += 1;

              return Response.json({
                status: "queued",
              });
            },
          }),
          idFromName: () => "submission-sync-id",
        } as unknown as DurableObjectNamespace,
      },
    );
    const body = (await response.json()) as {
      data: { content: string };
      type: number;
    };

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain("初期同期を開始しました。");
    expect(startRequests).toBe(1);
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
