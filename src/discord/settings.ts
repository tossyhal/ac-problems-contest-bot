import { booleanLabel } from "./responses";
import type {
  DifficultyBandRecord,
  DiscordApplicationCommandInteraction,
  SettingRecord,
} from "./types";

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
  next_contest_sequence: 1,
  exclude_recently_used_days: 14,
  visibility: "private",
  title_template: null,
  memo_template: null,
};

const allowedSlotMinutes = new Set([5, 10, 15, 30]);
const allowedVisibilityValues = new Set(["private", "public"]);
const atCoderUserIdPattern = /^[A-Za-z0-9_]{3,24}$/;

const getOptionValue = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => interaction.data.options?.find((option) => option.name === name)?.value;

export const getStringOption = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => {
  const value = getOptionValue(interaction, name);

  return typeof value === "string" ? value : undefined;
};

export const getNumberOption = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => {
  const value = getOptionValue(interaction, name);

  return typeof value === "number" ? value : undefined;
};

export const getBooleanOption = (
  interaction: DiscordApplicationCommandInteraction,
  name: string,
) => {
  const value = getOptionValue(interaction, name);

  return typeof value === "boolean" ? value : undefined;
};

export const parseDifficultyBands = (value: string) => {
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

const validateAtCoderUserId = (value: string | null) => {
  if (value === null) {
    return value;
  }

  if (!atCoderUserIdPattern.test(value)) {
    throw new Error(
      "atcoder-user-id は 3〜24 文字の英数字またはアンダースコアで指定してください。",
    );
  }

  return value;
};

const validateSlotMinutes = (value: number) => {
  if (!allowedSlotMinutes.has(value)) {
    throw new Error(
      "slot-minutes は 5, 10, 15, 30 のいずれかを指定してください。",
    );
  }

  return value;
};

const validateVisibility = (value: string) => {
  if (!allowedVisibilityValues.has(value)) {
    throw new Error("visibility は private または public を指定してください。");
  }

  return value;
};

export const getSettingRecord = async (database: D1Database) => {
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
        next_contest_sequence,
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

export const getDifficultyBands = async (database: D1Database) => {
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

export const replaceDifficultyBands = async (
  database: D1Database,
  difficultyBands: DifficultyBandRecord[],
) => {
  const statements = [
    database
      .prepare(`DELETE FROM setting_difficulty_bands WHERE setting_id = ?`)
      .bind(1),
    ...difficultyBands.map((band) =>
      database
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
        ),
    ),
  ];

  if ("batch" in database && typeof database.batch === "function") {
    await database.batch(statements);
    return;
  }

  for (const statement of statements) {
    await statement.run();
  }
};

export const createUpdatedSettingRecord = (
  currentSetting: SettingRecord,
  interaction: DiscordApplicationCommandInteraction,
): SettingRecord => ({
  atcoder_user_id: validateAtCoderUserId(
    getStringOption(interaction, "atcoder-user-id") ??
      currentSetting.atcoder_user_id,
  ),
  default_slot_minutes: validateSlotMinutes(
    getNumberOption(interaction, "slot-minutes") ??
      currentSetting.default_slot_minutes,
  ),
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
  next_contest_sequence: currentSetting.next_contest_sequence,
  exclude_recently_used_days:
    getNumberOption(interaction, "exclude-recently-used-days") ??
    currentSetting.exclude_recently_used_days,
  visibility: validateVisibility(
    getStringOption(interaction, "visibility") ?? currentSetting.visibility,
  ),
  title_template: currentSetting.title_template,
  memo_template:
    getStringOption(interaction, "memo-template") ??
    currentSetting.memo_template,
});

export const upsertSettingRecord = async (
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
        next_contest_sequence,
      exclude_recently_used_days,
      visibility,
      title_template,
      memo_template
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        next_contest_sequence = excluded.next_contest_sequence,
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
      setting.next_contest_sequence,
      setting.exclude_recently_used_days,
      setting.visibility,
      setting.title_template,
      setting.memo_template,
    )
    .run();
};

export const createContestMemo = (setting: SettingRecord, startTime: Date) => {
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

export const buildCustomStartSetting = (
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
  default_slot_minutes: validateSlotMinutes(
    getNumberOption(interaction, "slot-minutes") ??
      currentSetting.default_slot_minutes,
  ),
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
  visibility: validateVisibility(currentSetting.visibility),
});

export const createSettingSummary = (
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
    `次のバチャ番号: #${setting.next_contest_sequence}`,
    `直近使用問題除外: ${setting.exclude_recently_used_days}日`,
    `公開設定: ${setting.visibility}`,
    `難易度帯: ${difficultyBandSummary}`,
  ];

  if (setting.memo_template) {
    lines.push(`メモテンプレート: ${setting.memo_template}`);
  }

  return lines;
};
