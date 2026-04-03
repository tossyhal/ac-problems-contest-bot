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
import { selectProblems } from "../problem-selection/select";

type DiscordCommandOption = {
  name: string;
  type: number;
  value?: boolean | number | string;
};

type DiscordCommandData = {
  name: string;
  options?: DiscordCommandOption[];
};

type DiscordApplicationCommandInteraction = {
  type: 2;
  data: DiscordCommandData;
};

type SettingRecord = {
  atcoder_user_id: string | null;
  default_slot_minutes: number;
  default_problem_count: number;
  default_contest_duration_minutes: number;
  default_penalty_seconds: number;
  include_experimental_difficulty: number;
  include_abc: number;
  include_arc: number;
  include_agc: number;
  allow_other_sources: number;
  exclude_recently_used_days: number;
  visibility: string;
  title_template: string | null;
  memo_template: string | null;
};

type DifficultyBandRecord = {
  id?: number;
  setting_id?: number;
  sort_order?: number;
  difficulty_min: number;
  difficulty_max: number;
  problem_count: number;
};

type CommandOptions = {
  atCoderProblemsToken?: string;
  contestCreationGuard?: DurableObjectNamespace;
  fetchFn?: typeof fetch;
  problemCatalogSync?: DurableObjectNamespace;
  submissionSync?: DurableObjectNamespace;
};

const defaultSettingRecord: SettingRecord = {
  atcoder_user_id: null,
  default_slot_minutes: 5,
  default_problem_count: 5,
  default_contest_duration_minutes: 100,
  default_penalty_seconds: 300,
  include_experimental_difficulty: 0,
  include_abc: 1,
  include_arc: 1,
  include_agc: 1,
  allow_other_sources: 0,
  exclude_recently_used_days: 14,
  visibility: "private",
  title_template: null,
  memo_template: null,
};

const booleanLabel = (value: number) => (value ? "ON" : "OFF");

const formatTimestamp = (value: number | null) =>
  value ? new Date(value).toISOString() : "未実行";

const getOptionValue = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => interaction.data.options?.find((option) => option.name === name)?.value;

const getStringOption = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => {
  const value = getOptionValue(interaction, name);

  return typeof value === "string" ? value : undefined;
};

const getNumberOption = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => {
  const value = getOptionValue(interaction, name);

  return typeof value === "number" ? value : undefined;
};

const getBooleanOption = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => {
  const value = getOptionValue(interaction, name);

  return typeof value === "boolean" ? value : undefined;
};

const parseDifficultyBands = (value: string) => {
  const normalized = value.trim();

  if (!normalized) {
    return [];
  }

  return normalized.split(",").map((rawBand, index) => {
    const band = rawBand.trim();
    const match = band.match(/^(\d+)-(\d+):(\d+)$/);

    if (!match) {
      throw new Error(
        "difficulty-bands は 800-999:2,1000-1199:2 の形式で指定してください。",
      );
    }

    const [, min, max, count] = match;
    const difficultyMin = Number(min);
    const difficultyMax = Number(max);
    const problemCount = Number(count);

    if (difficultyMin > difficultyMax) {
      throw new Error("difficulty-bands の下限は上限以下にしてください。");
    }

    return {
      sort_order: index,
      difficulty_min: difficultyMin,
      difficulty_max: difficultyMax,
      problem_count: problemCount,
    };
  });
};

const getSettingRecord = async (database: D1Database) => {
  const result = await database
    .prepare(
      `SELECT
        atcoder_user_id,
        default_slot_minutes,
        default_problem_count,
        default_contest_duration_minutes,
        default_penalty_seconds,
        include_experimental_difficulty,
        include_abc,
        include_arc,
        include_agc,
        allow_other_sources,
        exclude_recently_used_days,
        visibility,
        title_template,
        memo_template
      FROM settings
      WHERE id = 1`,
    )
    .first<SettingRecord>();

  return result ?? defaultSettingRecord;
};

const getDifficultyBands = async (database: D1Database) => {
  const result = await database
    .prepare(
      `SELECT id, setting_id, sort_order, difficulty_min, difficulty_max, problem_count
      FROM setting_difficulty_bands
      WHERE setting_id = 1
      ORDER BY sort_order ASC`,
    )
    .all<DifficultyBandRecord>();

  return result.results;
};

const replaceDifficultyBands = async (
  database: D1Database,
  difficultyBands: DifficultyBandRecord[],
) => {
  await database
    .prepare(`DELETE FROM setting_difficulty_bands WHERE setting_id = ?`)
    .bind(1)
    .run();

  for (const band of difficultyBands) {
    await database
      .prepare(
        `INSERT INTO setting_difficulty_bands (
          setting_id,
          sort_order,
          difficulty_min,
          difficulty_max,
          problem_count
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        1,
        band.sort_order ?? 0,
        band.difficulty_min,
        band.difficulty_max,
        band.problem_count,
      )
      .run();
  }
};

const createUpdatedSettingRecord = (
  currentSetting: SettingRecord,
  interaction: DiscordApplicationCommandInteraction,
): SettingRecord => ({
  atcoder_user_id:
    getStringOption(interaction, "atcoder-user-id") ??
    currentSetting.atcoder_user_id,
  default_slot_minutes:
    getNumberOption(interaction, "slot-minutes") ??
    currentSetting.default_slot_minutes,
  default_problem_count:
    getNumberOption(interaction, "problem-count") ??
    currentSetting.default_problem_count,
  default_contest_duration_minutes:
    getNumberOption(interaction, "contest-minutes") ??
    currentSetting.default_contest_duration_minutes,
  default_penalty_seconds:
    getNumberOption(interaction, "penalty-seconds") ??
    currentSetting.default_penalty_seconds,
  include_experimental_difficulty: Number(
    getBooleanOption(interaction, "include-experimental-difficulty") ??
      Boolean(currentSetting.include_experimental_difficulty),
  ),
  include_abc: Number(
    getBooleanOption(interaction, "include-abc") ??
      Boolean(currentSetting.include_abc),
  ),
  include_arc: Number(
    getBooleanOption(interaction, "include-arc") ??
      Boolean(currentSetting.include_arc),
  ),
  include_agc: Number(
    getBooleanOption(interaction, "include-agc") ??
      Boolean(currentSetting.include_agc),
  ),
  allow_other_sources: Number(
    getBooleanOption(interaction, "allow-other-sources") ??
      Boolean(currentSetting.allow_other_sources),
  ),
  exclude_recently_used_days:
    getNumberOption(interaction, "exclude-recently-used-days") ??
    currentSetting.exclude_recently_used_days,
  visibility:
    getStringOption(interaction, "visibility") ?? currentSetting.visibility,
  title_template:
    getStringOption(interaction, "title-template") ??
    currentSetting.title_template,
  memo_template:
    getStringOption(interaction, "memo-template") ??
    currentSetting.memo_template,
});

const upsertSettingRecord = async (
  database: D1Database,
  setting: SettingRecord,
) => {
  await database
    .prepare(
      `INSERT INTO settings (
        id,
        atcoder_user_id,
        default_slot_minutes,
        default_problem_count,
        default_contest_duration_minutes,
        default_penalty_seconds,
        include_experimental_difficulty,
        include_abc,
        include_arc,
        include_agc,
        allow_other_sources,
        exclude_recently_used_days,
        visibility,
        title_template,
        memo_template
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        atcoder_user_id = excluded.atcoder_user_id,
        default_slot_minutes = excluded.default_slot_minutes,
        default_problem_count = excluded.default_problem_count,
        default_contest_duration_minutes = excluded.default_contest_duration_minutes,
        default_penalty_seconds = excluded.default_penalty_seconds,
        include_experimental_difficulty = excluded.include_experimental_difficulty,
        include_abc = excluded.include_abc,
        include_arc = excluded.include_arc,
        include_agc = excluded.include_agc,
        allow_other_sources = excluded.allow_other_sources,
        exclude_recently_used_days = excluded.exclude_recently_used_days,
        visibility = excluded.visibility,
        title_template = excluded.title_template,
        memo_template = excluded.memo_template,
        updated_at = (cast((julianday('now') - 2440587.5) * 86400000 as integer))`,
    )
    .bind(
      1,
      setting.atcoder_user_id,
      setting.default_slot_minutes,
      setting.default_problem_count,
      setting.default_contest_duration_minutes,
      setting.default_penalty_seconds,
      setting.include_experimental_difficulty,
      setting.include_abc,
      setting.include_arc,
      setting.include_agc,
      setting.allow_other_sources,
      setting.exclude_recently_used_days,
      setting.visibility,
      setting.title_template,
      setting.memo_template,
    )
    .run();
};

const createResponse = (content: string) =>
  Response.json({
    type: 4,
    data: {
      content,
    },
  });

const createHash = async (value: string) => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const createContestTitle = (
  setting: SettingRecord,
  startTime: Date,
  selectedProblems: { title: string }[],
) => {
  const startDate = startTime.toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tokyo",
  });
  const startDateTime = startTime.toLocaleString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const defaultTitle = `Practice Contest ${startDateTime}`;

  if (!setting.title_template) {
    return defaultTitle;
  }

  return setting.title_template
    .replaceAll("{startDate}", startDate)
    .replaceAll("{startDateTime}", startDateTime)
    .replaceAll("{problemCount}", String(selectedProblems.length));
};

const createContestMemo = (setting: SettingRecord, startTime: Date) => {
  const startDateTime = startTime.toLocaleString("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  if (!setting.memo_template) {
    return "";
  }

  return setting.memo_template.replaceAll("{startDateTime}", startDateTime);
};

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

const createContestProblemsPayload = (problems: { problem_id: string }[]) =>
  problems.map((problem, index) => ({
    id: problem.problem_id,
    order: index,
    point: (index + 1) * 100,
  }));

const buildCustomStartSetting = (
  interaction: DiscordApplicationCommandInteraction,
  currentSetting: SettingRecord,
) => ({
  ...currentSetting,
  allow_other_sources: Number(
    getBooleanOption(interaction, "allow-other-sources") ??
      Boolean(currentSetting.allow_other_sources),
  ),
  default_contest_duration_minutes:
    getNumberOption(interaction, "contest-minutes") ??
    currentSetting.default_contest_duration_minutes,
  default_problem_count:
    getNumberOption(interaction, "problem-count") ??
    currentSetting.default_problem_count,
  default_slot_minutes:
    getNumberOption(interaction, "slot-minutes") ??
    currentSetting.default_slot_minutes,
  exclude_recently_used_days:
    getNumberOption(interaction, "exclude-recently-used-days") ??
    currentSetting.exclude_recently_used_days,
  include_abc: Number(
    getBooleanOption(interaction, "include-abc") ??
      Boolean(currentSetting.include_abc),
  ),
  include_agc: Number(
    getBooleanOption(interaction, "include-agc") ??
      Boolean(currentSetting.include_agc),
  ),
  include_arc: Number(
    getBooleanOption(interaction, "include-arc") ??
      Boolean(currentSetting.include_arc),
  ),
  include_experimental_difficulty: Number(
    getBooleanOption(interaction, "include-experimental-difficulty") ??
      Boolean(currentSetting.include_experimental_difficulty),
  ),
});

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

  do {
    result = await syncUserSubmissionsBatch({
      database,
      fetchFn: options.fetchFn,
      userId,
    });
  } while (result.status === "running");

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
    const selectedProblems = await selectProblems({
      database,
      difficultyBands: input.difficultyBands,
      settings: input.setting,
      unsolvedOnly: input.unsolvedOnly,
      userId: input.setting.atcoder_user_id,
    });
    const startTime = getNextStartTime(input.setting.default_slot_minutes);
    const startEpochSecond = Math.floor(startTime.getTime() / 1000);
    const title = createContestTitle(
      input.setting,
      startTime,
      selectedProblems,
    );
    const memo = createContestMemo(input.setting, startTime);
    const requestFingerprint = await createHash(
      JSON.stringify({
        difficultyBands: input.difficultyBands,
        problemIds: selectedProblems.map((problem) => problem.problem_id),
        startEpochSecond,
        visibility: input.setting.visibility,
      }),
    );
    const settingsSummary = JSON.stringify({
      difficultyBands: input.difficultyBands,
      problemIds: selectedProblems.map((problem) => problem.problem_id),
      startEpochSecond,
    });
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
              isPublic: input.setting.visibility === "public",
              memo,
              penaltySecond: input.setting.default_penalty_seconds,
              problemIds: selectedProblems.map((problem) => problem.problem_id),
              problems: createContestProblemsPayload(selectedProblems),
              requestFingerprint,
              settingsSummary,
              startEpochSecond,
              startTimeMs: startTime.getTime(),
              title,
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
          fetchFn: options.fetchFn,
          isPublic: input.setting.visibility === "public",
          memo,
          penaltySecond: input.setting.default_penalty_seconds,
          problemIds: selectedProblems.map((problem) => problem.problem_id),
          problems: createContestProblemsPayload(selectedProblems),
          requestFingerprint,
          settingsSummary,
          startEpochSecond,
          startTimeMs: startTime.getTime(),
          title,
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

const createSettingSummary = (
  setting: SettingRecord,
  difficultyBands: DifficultyBandRecord[],
) => {
  const difficultyBandSummary =
    difficultyBands.length > 0
      ? difficultyBands
          .map(
            (band) =>
              `${band.difficulty_min}-${band.difficulty_max}: ${band.problem_count}問`,
          )
          .join(", ")
      : "未設定";

  const lines = [
    "現在のデフォルト設定:",
    `AtCoder user ID: ${setting.atcoder_user_id ?? "未設定"}`,
    `開始時刻区切り: ${setting.default_slot_minutes}分`,
    `問題数: ${setting.default_problem_count}`,
    `コンテスト時間: ${setting.default_contest_duration_minutes}分`,
    `ペナルティ: ${setting.default_penalty_seconds}秒`,
    `experimental difficulty: ${booleanLabel(setting.include_experimental_difficulty)}`,
    `出典フィルタ: ABC=${booleanLabel(setting.include_abc)}, ARC=${booleanLabel(setting.include_arc)}, AGC=${booleanLabel(setting.include_agc)}, OTHER=${booleanLabel(setting.allow_other_sources)}`,
    `直近使用問題除外: ${setting.exclude_recently_used_days}日`,
    `公開設定: ${setting.visibility}`,
    `難易度帯: ${difficultyBandSummary}`,
  ];

  if (setting.title_template) {
    lines.push(`タイトルテンプレート: ${setting.title_template}`);
  }

  if (setting.memo_template) {
    lines.push(`メモテンプレート: ${setting.memo_template}`);
  }

  return lines;
};

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
  const action = getOptionValue(interaction, "action");

  if (action !== "show") {
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
  const action = getOptionValue(interaction, "action");

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
      await startSubmissionSyncJob(
        options.submissionSync,
        setting.atcoder_user_id,
      );

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

    return createResponse(
      [
        "初期同期を完了しました。",
        `status: ${syncState.status}`,
        `full sync completed at: ${formatTimestamp(syncState.full_sync_completed_at)}`,
        `last synced at: ${formatTimestamp(syncState.last_synced_at)}`,
        `last checkpoint: ${syncState.last_checkpoint ?? "未設定"}`,
      ].join("\n"),
    );
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
