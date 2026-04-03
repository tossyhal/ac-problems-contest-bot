import {
  getProblemCatalogStats,
  getProblemCatalogSyncState,
  isProblemCatalogStale,
  syncProblemCatalog,
} from "../atcoder-problems/problem-catalog";
import {
  getSyncState as getSubmissionSyncState,
  markSyncQueued,
  syncUserSubmissionsBatch,
  upsertSyncState,
} from "../atcoder-problems/submissions";
import { executeContestCreation } from "../contest-creation/service";
import { insertCommandLog } from "../db/command-log";
import { createResponse, formatTimestamp } from "./responses";
import {
  buildCustomStartSetting,
  createContestMemo,
  createSettingSummary,
  createUpdatedSettingRecord,
  getBooleanOption,
  getDifficultyBands,
  getSettingRecord,
  getStringOption,
  parseDifficultyBands,
  replaceDifficultyBands,
  upsertSettingRecord,
} from "./settings";
import type {
  CommandOptions,
  DifficultyBandRecord,
  DiscordApplicationCommandInteraction,
  SettingRecord,
} from "./types";

const maxImmediateSubmissionSyncBatches = 3;

const createHash = async (value: string) => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const createContestRequestFingerprintPayload = (input: {
  difficultyBands: DifficultyBandRecord[];
  memo: string;
  setting: Pick<
    SettingRecord,
    | "allow_other_sources"
    | "default_contest_duration_minutes"
    | "default_penalty_seconds"
    | "default_problem_count"
    | "exclude_recently_used_days"
    | "include_abc"
    | "include_agc"
    | "include_arc"
    | "include_experimental_difficulty"
    | "visibility"
  >;
  startEpochSecond: number;
  unsolvedOnly: boolean;
  userId: string;
}) => ({
  allowOtherSources: input.setting.allow_other_sources,
  defaultContestDurationMinutes: input.setting.default_contest_duration_minutes,
  defaultPenaltySeconds: input.setting.default_penalty_seconds,
  defaultProblemCount: input.setting.default_problem_count,
  difficultyBands: input.difficultyBands,
  excludeRecentlyUsedDays: input.setting.exclude_recently_used_days,
  includeAbc: input.setting.include_abc,
  includeAgc: input.setting.include_agc,
  includeArc: input.setting.include_arc,
  includeExperimentalDifficulty: input.setting.include_experimental_difficulty,
  memo: input.memo,
  startEpochSecond: input.startEpochSecond,
  unsolvedOnly: input.unsolvedOnly,
  userId: input.userId,
  visibility: input.setting.visibility,
});

const getNextStartTime = (slotMinutes: number) => {
  const now = new Date();
  const next = new Date(now.getTime());

  next.setSeconds(0, 0);

  const minutes = next.getMinutes();
  const remainder = minutes % slotMinutes;
  const addMinutes = remainder === 0 ? slotMinutes : slotMinutes - remainder;

  next.setMinutes(minutes + addMinutes);

  return next;
};

const ensureProblemCatalogReady = async (
  database: D1Database,
  options: CommandOptions,
) => {
  const syncState = await getProblemCatalogSyncState(database);

  if (syncState.status === "queued" || syncState.status === "running") {
    return {
      queued: true,
    };
  }

  const stale = await isProblemCatalogStale(database);

  if (!stale) {
    return {
      queued: false,
    };
  }

  if (options.problemCatalogSync) {
    const stub = options.problemCatalogSync.get(
      options.problemCatalogSync.idFromName("global-problem-catalog"),
    );
    const response = await stub.fetch("https://problem-catalog-sync/refresh", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("問題カタログ同期ジョブの開始に失敗しました。");
    }

    return {
      queued: true,
    };
  }

  await syncProblemCatalog({
    database,
    fetchFn: options.fetchFn,
  });

  return {
    queued: false,
  };
};

const startSubmissionSyncJob = async (
  submissionSync: DurableObjectNamespace,
  userId: string,
) => {
  const stub = submissionSync.get(submissionSync.idFromName(userId));
  const response = await stub.fetch("https://submission-sync/start", {
    method: "POST",
    body: JSON.stringify({
      userId,
    }),
  });

  if (!response.ok) {
    throw new Error("提出同期ジョブの開始に失敗しました。");
  }
};

const ensureSubmissionSyncReadyForContest = async (
  database: D1Database,
  options: CommandOptions,
  commandName: "custom-start" | "start",
  userId: string,
) => {
  const currentSyncState = await getSubmissionSyncState(database);

  if (
    currentSyncState.status === "queued" ||
    currentSyncState.status === "running"
  ) {
    return {
      message:
        "提出同期が実行中です。少し待ってからもう一度コマンドを実行してください。",
      ready: false,
    };
  }

  if (!currentSyncState.full_sync_completed_at) {
    return {
      message:
        "提出同期が未完了です。/init action:run を先に実行してください。",
      ready: false,
    };
  }

  if (options.submissionSync) {
    const result = await syncUserSubmissionsBatch({
      database,
      fetchFn: options.fetchFn,
      userId,
    });

    if (result.status === "completed") {
      return {
        ready: true,
      };
    }

    if (result.status === "failed") {
      const failedState = await getSubmissionSyncState(database);

      return {
        message: `提出同期に失敗しました。${failedState.last_error ?? "エラー内容は不明です。"}`,
        ready: false,
      };
    }

    try {
      await startSubmissionSyncJob(options.submissionSync, userId);
    } catch (error) {
      const currentState = await getSubmissionSyncState(database);
      const message =
        error instanceof Error
          ? error.message
          : "提出同期ジョブの開始に失敗しました。";

      await upsertSyncState(database, {
        ...currentState,
        last_error: message,
        status: "failed",
      });

      return {
        message: `提出同期ジョブの開始に失敗しました。${message}`,
        ready: false,
      };
    }

    return {
      message: `提出情報の増分同期を開始しました。少し待ってから /${commandName} を再実行してください。`,
      ready: false,
    };
  }

  let result: Awaited<ReturnType<typeof syncUserSubmissionsBatch>> | undefined;
  let batchCount = 0;

  do {
    result = await syncUserSubmissionsBatch({
      database,
      fetchFn: options.fetchFn,
      userId,
    });
    batchCount += 1;
  } while (
    result.status === "running" &&
    batchCount < maxImmediateSubmissionSyncBatches
  );

  if (result.status === "running") {
    return {
      message:
        "提出情報の増分同期がまだ継続中です。少し待ってからコマンドを再実行してください。",
      ready: false,
    };
  }

  if (result.status === "failed") {
    const failedState = await getSubmissionSyncState(database);

    return {
      message: `提出同期に失敗しました。${failedState.last_error ?? "エラー内容は不明です。"}`,
      ready: false,
    };
  }

  return {
    ready: true,
  };
};

const runContestCreation = async (
  database: D1Database,
  options: CommandOptions,
  input: {
    commandName: "custom-start" | "start";
    commandContext?: string;
    difficultyBands: DifficultyBandRecord[];
    setting: SettingRecord;
    unsolvedOnly: boolean;
  },
) => {
  const atcoderUserId = input.setting.atcoder_user_id;

  if (!atcoderUserId) {
    return createResponse(
      "AtCoder user ID が未設定です。/setting action:update で atcoder-user-id を設定してください。",
    );
  }

  if (!options.atCoderProblemsToken) {
    return createResponse("ATCODER_PROBLEMS_TOKEN が未設定です。");
  }

  const submissionSyncResult = await ensureSubmissionSyncReadyForContest(
    database,
    options,
    input.commandName,
    atcoderUserId,
  );

  if (!submissionSyncResult.ready) {
    return createResponse(
      submissionSyncResult.message ?? "提出同期の確認に失敗しました。",
    );
  }

  const catalogResult = await ensureProblemCatalogReady(database, options);

  if (catalogResult.queued) {
    return createResponse(
      `問題カタログ同期を開始しました。少し待ってから /${input.commandName} を再実行してください。`,
    );
  }

  try {
    const startTime = getNextStartTime(input.setting.default_slot_minutes);
    const startEpochSecond = Math.floor(startTime.getTime() / 1000);
    const memo = createContestMemo(input.setting, startTime);
    const fingerprintPayload = createContestRequestFingerprintPayload({
      difficultyBands: input.difficultyBands,
      memo,
      setting: input.setting,
      startEpochSecond,
      unsolvedOnly: input.unsolvedOnly,
      userId: atcoderUserId,
    });
    const requestFingerprint = await createHash(
      JSON.stringify(fingerprintPayload),
    );
    const settingsSummary = JSON.stringify(fingerprintPayload);
    const createdContest = options.contestCreationGuard
      ? await options.contestCreationGuard
          .get(options.contestCreationGuard.idFromName(requestFingerprint))
          .fetch("https://contest-creation-guard/create", {
            method: "POST",
            body: JSON.stringify({
              commandContext: input.commandContext,
              commandName: input.commandName,
              durationSecond:
                input.setting.default_contest_duration_minutes * 60,
              difficultyBands: input.difficultyBands,
              isPublic: input.setting.visibility === "public",
              memo,
              penaltySecond: input.setting.default_penalty_seconds,
              requestFingerprint,
              settings: input.setting,
              settingsSummary,
              startEpochSecond,
              startTimeMs: startTime.getTime(),
              unsolvedOnly: input.unsolvedOnly,
              userId: atcoderUserId,
            }),
          })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(await response.text());
            }

            return (await response.json()) as {
              contestId: string;
              contestUrl: string;
              reused: boolean;
            };
          })
      : await executeContestCreation(database, {
          atCoderProblemsToken: options.atCoderProblemsToken,
          commandContext: input.commandContext,
          commandName: input.commandName,
          durationSecond: input.setting.default_contest_duration_minutes * 60,
          difficultyBands: input.difficultyBands,
          fetchFn: options.fetchFn,
          isPublic: input.setting.visibility === "public",
          memo,
          penaltySecond: input.setting.default_penalty_seconds,
          requestFingerprint,
          settings: input.setting,
          settingsSummary,
          startEpochSecond,
          startTimeMs: startTime.getTime(),
          unsolvedOnly: input.unsolvedOnly,
          userId: atcoderUserId,
        });

    return createResponse(
      [
        createdContest.contestUrl,
        createdContest.reused
          ? "既存のバチャを再利用しました。"
          : "バチャを作成しました。",
        `開始時刻: ${startTime.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })} JST`,
      ].join("\n"),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "バチャ作成に失敗しました。";

    await insertCommandLog(database, {
      commandContext: input.commandContext,
      commandName: input.commandName,
      message,
      status: "failed",
    });

    return createResponse(message);
  }
};

const handleStart = async (database: D1Database, options: CommandOptions) =>
  runContestCreation(database, options, {
    commandName: "start",
    difficultyBands: await getDifficultyBands(database),
    setting: await getSettingRecord(database),
    unsolvedOnly: true,
  });

const handleCustomStart = async (
  database: D1Database,
  interaction: DiscordApplicationCommandInteraction,
  options: CommandOptions,
) => {
  const currentSetting = await getSettingRecord(database);
  const customSetting = buildCustomStartSetting(interaction, currentSetting);
  const difficultyBandsInput = getStringOption(interaction, "difficulty-bands");
  const difficultyBands =
    difficultyBandsInput === undefined
      ? await getDifficultyBands(database)
      : parseDifficultyBands(difficultyBandsInput);
  return runContestCreation(database, options, {
    commandContext: JSON.stringify(interaction.data.options ?? []),
    commandName: "custom-start",
    difficultyBands,
    setting: customSetting,
    unsolvedOnly: getBooleanOption(interaction, "unsolved-only") ?? true,
  });
};

const handleSetting = async (
  database: D1Database,
  interaction: DiscordApplicationCommandInteraction,
) => {
  const action = getStringOption(interaction, "action");

  if (action === "update") {
    try {
      const currentSetting = await getSettingRecord(database);
      const nextSetting = createUpdatedSettingRecord(
        currentSetting,
        interaction,
      );
      const difficultyBandsInput = getStringOption(
        interaction,
        "difficulty-bands",
      );
      const nextDifficultyBands =
        difficultyBandsInput === undefined
          ? await getDifficultyBands(database)
          : parseDifficultyBands(difficultyBandsInput);

      const currentDifficultyBands = await getDifficultyBands(database);
      const hasChanges =
        JSON.stringify(currentSetting) !== JSON.stringify(nextSetting) ||
        JSON.stringify(currentDifficultyBands) !==
          JSON.stringify(nextDifficultyBands);

      if (!hasChanges) {
        return createResponse(
          "更新対象が指定されていません。action=update と一緒に更新項目を渡してください。",
        );
      }

      await upsertSettingRecord(database, nextSetting);
      if (difficultyBandsInput !== undefined) {
        await replaceDifficultyBands(database, nextDifficultyBands);
      }

      const difficultyBands = await getDifficultyBands(database);
      const problemCatalogCount = await getProblemCatalogStats(database);

      return createResponse(
        [
          "デフォルト設定を更新しました。",
          ...createSettingSummary(nextSetting, difficultyBands),
          `問題カタログ件数: ${problemCatalogCount}`,
        ].join("\n"),
      );
    } catch (error) {
      return createResponse(
        error instanceof Error ? error.message : "設定更新に失敗しました。",
      );
    }
  }

  if (action !== "show") {
    return createResponse("action は show または update を指定してください。");
  }

  const setting = await getSettingRecord(database);
  const difficultyBands = await getDifficultyBands(database);
  const problemCatalogCount = await getProblemCatalogStats(database);
  return createResponse(
    [
      ...createSettingSummary(setting, difficultyBands),
      `問題カタログ件数: ${problemCatalogCount}`,
    ].join("\n"),
  );
};

const handleInit = async (
  database: D1Database,
  interaction: DiscordApplicationCommandInteraction,
  options: CommandOptions,
) => {
  const action = getStringOption(interaction, "action");

  if (action === "run") {
    const setting = await getSettingRecord(database);

    if (!setting.atcoder_user_id) {
      return createResponse(
        "AtCoder user ID が未設定です。/setting action:update で atcoder-user-id を設定してください。",
      );
    }

    const currentSyncState = await getSubmissionSyncState(database);

    if (
      currentSyncState.status === "queued" ||
      currentSyncState.status === "running"
    ) {
      return createResponse(
        [
          "初期同期はすでに実行中です。",
          `status: ${currentSyncState.status}`,
          "進捗と結果は /init action:status で確認してください。",
        ].join("\n"),
      );
    }

    if (options.submissionSync) {
      await markSyncQueued(database);

      try {
        await startSubmissionSyncJob(
          options.submissionSync,
          setting.atcoder_user_id,
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "提出同期ジョブの開始に失敗しました。";

        await upsertSyncState(database, {
          ...(await getSubmissionSyncState(database)),
          last_error: message,
          status: "failed",
        });

        return createResponse(`初期同期ジョブの開始に失敗しました。${message}`);
      }

      return createResponse(
        [
          "初期同期を開始しました。",
          "進捗と結果は /init action:status で確認してください。",
        ].join("\n"),
      );
    }

    await markSyncQueued(database);
    await syncUserSubmissionsBatch({
      database,
      fetchFn: options.fetchFn,
      userId: setting.atcoder_user_id,
    });

    const syncState = await getSubmissionSyncState(database);
    const initStatusMessage =
      syncState.status === "running"
        ? "初期同期を1バッチ処理しました。続きがあるため、もう一度 /init action:run を実行してください。"
        : "初期同期を完了しました。";

    return createResponse(
      [
        initStatusMessage,
        `status: ${syncState.status}`,
        `full sync completed at: ${formatTimestamp(syncState.full_sync_completed_at)}`,
        `last synced at: ${formatTimestamp(syncState.last_synced_at)}`,
        `last checkpoint: ${syncState.last_checkpoint ?? "未設定"}`,
      ].join("\n"),
    );
  }

  if (action !== "status") {
    return createResponse("action は run または status を指定してください。");
  }

  const syncState = await getSubmissionSyncState(database);
  const lines = [
    "現在の同期状態:",
    `status: ${syncState.status}`,
    `full sync completed at: ${formatTimestamp(syncState.full_sync_completed_at)}`,
    `last synced at: ${formatTimestamp(syncState.last_synced_at)}`,
    `last checkpoint: ${syncState.last_checkpoint ?? "未設定"}`,
    `last success checkpoint: ${syncState.last_success_checkpoint ?? "未設定"}`,
    `last error: ${syncState.last_error ?? "なし"}`,
  ];

  return createResponse(lines.join("\n"));
};

export const handleDiscordCommand = async (
  database: D1Database | undefined,
  interaction: DiscordApplicationCommandInteraction,
  options: CommandOptions = {},
) => {
  switch (interaction.data.name) {
    case "start":
      if (!database) {
        return Response.json(
          {
            error: "DB binding is not configured.",
          },
          { status: 500 },
        );
      }
      return handleStart(database, options);
    case "custom-start":
      if (!database) {
        return Response.json(
          {
            error: "DB binding is not configured.",
          },
          { status: 500 },
        );
      }
      return handleCustomStart(database, interaction, options);
    case "setting":
      if (!database) {
        return Response.json(
          {
            error: "DB binding is not configured.",
          },
          { status: 500 },
        );
      }
      return handleSetting(database, interaction);
    case "init":
      if (!database) {
        return Response.json(
          {
            error: "DB binding is not configured.",
          },
          { status: 500 },
        );
      }
      return handleInit(database, interaction, options);
    default:
      return Response.json(
        {
          error: "Unsupported Discord interaction.",
        },
        { status: 400 },
      );
  }
};
