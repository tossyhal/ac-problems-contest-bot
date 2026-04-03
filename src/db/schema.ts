import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  atcoderUserId: text("atcoder_user_id"),
  defaultSlotMinutes: integer("default_slot_minutes").notNull().default(5),
  defaultProblemCount: integer("default_problem_count").notNull().default(5),
  defaultContestDurationMinutes: integer("default_contest_duration_minutes")
    .notNull()
    .default(100),
  defaultPenaltySeconds: integer("default_penalty_seconds")
    .notNull()
    .default(300),
  includeExperimentalDifficulty: integer("include_experimental_difficulty", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  includeAbc: integer("include_abc", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  includeArc: integer("include_arc", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  includeAgc: integer("include_agc", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  allowOtherSources: integer("allow_other_sources", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  nextContestSequence: integer("next_contest_sequence").notNull().default(1),
  excludeRecentlyUsedDays: integer("exclude_recently_used_days")
    .notNull()
    .default(14),
  visibility: text("visibility").notNull().default("private"),
  titleTemplate: text("title_template"),
  memoTemplate: text("memo_template"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .defaultNow(),
});

export const settingDifficultyBands = sqliteTable(
  "setting_difficulty_bands",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    settingId: integer("setting_id")
      .notNull()
      .references(() => settings.id),
    sortOrder: integer("sort_order").notNull(),
    difficultyMin: integer("difficulty_min").notNull(),
    difficultyMax: integer("difficulty_max").notNull(),
    problemCount: integer("problem_count").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    settingSortOrderIdx: uniqueIndex(
      "setting_difficulty_bands_setting_sort_order_idx",
    ).on(table.settingId, table.sortOrder),
    settingIdIdx: index("setting_difficulty_bands_setting_id_idx").on(
      table.settingId,
    ),
  }),
);

export const syncStates = sqliteTable("sync_states", {
  scope: text("scope").primaryKey(),
  status: text("status").notNull().default("idle"),
  fullSyncCompletedAt: integer("full_sync_completed_at", {
    mode: "timestamp_ms",
  }),
  lastSyncedAt: integer("last_synced_at", {
    mode: "timestamp_ms",
  }),
  lastCheckpoint: text("last_checkpoint"),
  lastSuccessCheckpoint: text("last_success_checkpoint"),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .defaultNow(),
});

export const solvedProblems = sqliteTable(
  "solved_problems",
  {
    atcoderUserId: text("atcoder_user_id").notNull(),
    problemId: text("problem_id").notNull(),
    solvedAt: integer("solved_at", { mode: "timestamp_ms" }),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.atcoderUserId, table.problemId],
    }),
    problemIdIdx: index("solved_problems_problem_id_idx").on(table.problemId),
  }),
);

export const problemCatalog = sqliteTable(
  "problem_catalog",
  {
    problemId: text("problem_id").primaryKey(),
    contestId: text("contest_id").notNull(),
    problemIndex: text("problem_index"),
    title: text("title").notNull(),
    difficulty: integer("difficulty"),
    isExperimental: integer("is_experimental", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    sourceCategory: text("source_category").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    contestIdIdx: index("problem_catalog_contest_id_idx").on(table.contestId),
    sourceCategoryIdx: index("problem_catalog_source_category_idx").on(
      table.sourceCategory,
    ),
    difficultyIdx: index("problem_catalog_difficulty_idx").on(table.difficulty),
  }),
);

export const problemUsageLogs = sqliteTable(
  "problem_usage_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    problemId: text("problem_id").notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull(),
    contestRunId: integer("contest_run_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    problemIdIdx: index("problem_usage_logs_problem_id_idx").on(
      table.problemId,
    ),
    usedAtIdx: index("problem_usage_logs_used_at_idx").on(table.usedAt),
  }),
);

export const contestRuns = sqliteTable(
  "contest_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestFingerprint: text("request_fingerprint").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    contestUrl: text("contest_url"),
    contestId: text("contest_id"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupeKeyIdx: uniqueIndex("contest_runs_dedupe_key_idx").on(
      table.dedupeKey,
    ),
    fingerprintIdx: index("contest_runs_request_fingerprint_idx").on(
      table.requestFingerprint,
    ),
  }),
);

export const commandLogs = sqliteTable(
  "command_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    commandName: text("command_name").notNull(),
    commandContext: text("command_context"),
    status: text("status").notNull(),
    settingsSummary: text("settings_summary"),
    message: text("message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    commandNameIdx: index("command_logs_command_name_idx").on(
      table.commandName,
    ),
    createdAtIdx: index("command_logs_created_at_idx").on(table.createdAt),
  }),
);

export const schema = {
  settings,
  settingDifficultyBands,
  syncStates,
  solvedProblems,
  problemCatalog,
  problemUsageLogs,
  contestRuns,
  commandLogs,
};

export type Schema = typeof schema;
