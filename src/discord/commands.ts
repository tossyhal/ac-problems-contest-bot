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

type SyncStateRecord = {
  status: string;
  full_sync_completed_at: number | null;
  last_synced_at: number | null;
  last_checkpoint: string | null;
  last_success_checkpoint: string | null;
  last_error: string | null;
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

const getSyncState = async (database: D1Database) => {
  const result = await database
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
    .first<SyncStateRecord>();

  return (
    result ?? {
      status: "idle",
      full_sync_completed_at: null,
      last_synced_at: null,
      last_checkpoint: null,
      last_success_checkpoint: null,
      last_error: null,
    }
  );
};

const upsertSyncState = async (
  database: D1Database,
  syncState: SyncStateRecord,
) => {
  await database
    .prepare(
      `INSERT INTO sync_states (
        scope,
        status,
        full_sync_completed_at,
        last_synced_at,
        last_checkpoint,
        last_success_checkpoint,
        last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        status = excluded.status,
        full_sync_completed_at = excluded.full_sync_completed_at,
        last_synced_at = excluded.last_synced_at,
        last_checkpoint = excluded.last_checkpoint,
        last_success_checkpoint = excluded.last_success_checkpoint,
        last_error = excluded.last_error,
        updated_at = (cast((julianday('now') - 2440587.5) * 86400000 as integer))`,
    )
    .bind(
      "submissions",
      syncState.status,
      syncState.full_sync_completed_at,
      syncState.last_synced_at,
      syncState.last_checkpoint,
      syncState.last_success_checkpoint,
      syncState.last_error,
    )
    .run();
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

const handleStart = () =>
  createResponse("デフォルト設定でのバチャ作成は未実装です。");

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
    `penalty second: ${setting.default_penalty_seconds}`,
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

const handleCustomStart = (
  interaction: DiscordApplicationCommandInteraction,
) => {
  const problemCount = getOptionValue(interaction, "problem-count");
  const contestDurationMinutes = getOptionValue(interaction, "contest-minutes");
  const slotMinutes = getOptionValue(interaction, "slot-minutes");
  const unsolvedOnly = getOptionValue(interaction, "unsolved-only");
  const includeExperimentalDifficulty = getOptionValue(
    interaction,
    "include-experimental-difficulty",
  );

  const lines = [
    "条件を上書きしたバチャ作成は未実装です。",
    `problem-count: ${problemCount ?? "未指定"}`,
    `contest-duration-minutes: ${contestDurationMinutes ?? "未指定"}`,
    `slot-minutes: ${slotMinutes ?? "未指定"}`,
    `unsolved-only: ${unsolvedOnly ?? "未指定"}`,
    `include-experimental-difficulty: ${includeExperimentalDifficulty ?? "未指定"}`,
  ];

  return createResponse(lines.join("\n"));
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

      return createResponse(
        [
          "デフォルト設定を更新しました。",
          ...createSettingSummary(nextSetting, difficultyBands),
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
  return createResponse(
    createSettingSummary(setting, difficultyBands).join("\n"),
  );
};

const handleInit = async (
  database: D1Database,
  interaction: DiscordApplicationCommandInteraction,
) => {
  const action = getOptionValue(interaction, "action");

  if (action === "run") {
    const now = Date.now();
    const nextSyncState: SyncStateRecord = {
      status: "completed",
      full_sync_completed_at: now,
      last_synced_at: now,
      last_checkpoint: "bootstrap",
      last_success_checkpoint: "bootstrap",
      last_error: null,
    };

    await upsertSyncState(database, nextSyncState);

    return createResponse(
      [
        "初期同期を完了扱いで初期化しました。",
        `status: ${nextSyncState.status}`,
        `full sync completed at: ${formatTimestamp(nextSyncState.full_sync_completed_at)}`,
        `last synced at: ${formatTimestamp(nextSyncState.last_synced_at)}`,
        `last checkpoint: ${nextSyncState.last_checkpoint}`,
      ].join("\n"),
    );
  }

  const syncState = await getSyncState(database);
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
) => {
  switch (interaction.data.name) {
    case "start":
      return handleStart();
    case "custom-start":
      return handleCustomStart(interaction);
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
      return handleInit(database, interaction);
    default:
      return Response.json(
        {
          error: "Unsupported Discord interaction.",
        },
        { status: 400 },
      );
  }
};
