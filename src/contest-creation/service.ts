import {
  createContest,
  PartialContestCreationError,
} from "../atcoder-problems/contest";
import { insertCommandLog } from "../db/command-log";
import { selectProblems } from "../problem-selection/select";

type DifficultyBandRecord = {
  difficulty_max: number;
  difficulty_min: number;
  problem_count: number;
};

type ProblemSelectionSettings = {
  allow_other_sources: number;
  default_problem_count: number;
  exclude_recently_used_days: number;
  include_abc: number;
  include_agc: number;
  include_arc: number;
  include_experimental_difficulty: number;
  next_contest_sequence: number;
};

export type ExecuteContestCreationInput = {
  atCoderProblemsToken: string;
  atCoderProblemsRequestIntervalMs?: number;
  commandContext?: string;
  commandName: "custom-start" | "start";
  durationSecond: number;
  difficultyBands: DifficultyBandRecord[];
  fetchFn?: typeof fetch;
  isPublic: boolean;
  memo: string;
  penaltySecond: number;
  requestFingerprint: string;
  settings: ProblemSelectionSettings;
  settingsSummary: string;
  startEpochSecond: number;
  startTimeMs: number;
  unsolvedOnly: boolean;
  userId: string;
};

type ContestRunRecord = {
  contest_id: null | string;
  contest_url: null | string;
  id: number;
  status: string;
};

const createRunKey = () => `${Date.now()}:${crypto.randomUUID()}`;

const createContestTitle = (contestSequence: number) =>
  `自分用バチャ #${contestSequence}`;

const createContestProblemsPayload = (problems: { problem_id: string }[]) =>
  problems.map((problem, index) => ({
    id: problem.problem_id,
    order: index,
    point: (index + 1) * 100,
  }));

const reserveNextContestSequence = async (database: D1Database) => {
  const result = await database
    .prepare(
      `UPDATE settings
      SET
        next_contest_sequence = next_contest_sequence + 1,
        updated_at = (cast((julianday('now') - 2440587.5) * 86400000 as integer))
      WHERE id = 1
      RETURNING next_contest_sequence - 1 AS contest_sequence`,
    )
    .first<{ contest_sequence: number | string }>();

  if (!result) {
    throw new Error("settings レコードが見つからないため採番できません。");
  }

  return Number(result.contest_sequence);
};

const insertContestRun = async (
  database: D1Database,
  input: {
    dedupeKey: string;
    requestFingerprint: string;
    startedAt: number;
  },
) => {
  const result = await database
    .prepare(
      `INSERT INTO contest_runs (
        request_fingerprint,
        dedupe_key,
        status,
        started_at
      ) VALUES (?, ?, ?, ?)`,
    )
    .bind(input.requestFingerprint, input.dedupeKey, "running", input.startedAt)
    .run<{ meta?: { last_row_id?: number } }>();

  return Number(result.meta?.last_row_id ?? 0);
};

const updateContestRun = async (
  database: D1Database,
  input: {
    contestId?: string;
    contestRunId: number;
    contestUrl?: string;
    errorMessage?: string;
    status: string;
  },
) => {
  await database
    .prepare(
      `UPDATE contest_runs
      SET
        status = ?,
        contest_url = ?,
        contest_id = ?,
        error_message = ?,
        updated_at = (cast((julianday('now') - 2440587.5) * 86400000 as integer))
      WHERE id = ?`,
    )
    .bind(
      input.status,
      input.contestUrl ?? null,
      input.contestId ?? null,
      input.errorMessage ?? null,
      input.contestRunId,
    )
    .run();
};

const recordBookkeepingFailure = async (
  database: D1Database,
  input: {
    commandContext?: string;
    commandName: "custom-start" | "start";
    contestUrl: string;
    error: unknown;
    settingsSummary: string;
  },
) => {
  const message =
    input.error instanceof Error
      ? input.error.message
      : "contest bookkeeping failed";

  console.error("[contest] post-create bookkeeping failed", {
    commandName: input.commandName,
    contestUrl: input.contestUrl,
    error: message,
  });

  try {
    await insertCommandLog(database, {
      commandContext: input.commandContext,
      commandName: input.commandName,
      message: `${input.contestUrl}\nbookkeeping error: ${message}`,
      settingsSummary: input.settingsSummary,
      status: "completed",
    });
  } catch (logError) {
    console.error("[contest] failed to record bookkeeping error", {
      contestUrl: input.contestUrl,
      error: logError instanceof Error ? logError.message : logError,
    });
  }
};

const insertProblemUsageLogs = async (
  database: D1Database,
  input: {
    contestRunId: number;
    problemIds: string[];
    usedAt: number;
  },
) => {
  const statements = input.problemIds.map((problemId) =>
    database
      .prepare(
        `INSERT INTO problem_usage_logs (
          problem_id,
          used_at,
          contest_run_id
        ) VALUES (?, ?, ?)`,
      )
      .bind(problemId, input.usedAt, input.contestRunId),
  );

  if ("batch" in database && typeof database.batch === "function") {
    await database.batch(statements);
    return;
  }

  for (const statement of statements) {
    await statement.run();
  }
};

export const findCompletedContestRunByFingerprint = async (
  database: D1Database,
  requestFingerprint: string,
) =>
  database
    .prepare(
      `SELECT id, status, contest_url, contest_id
      FROM contest_runs
      WHERE request_fingerprint = ? AND status = 'completed'
      ORDER BY id DESC
      LIMIT 1`,
    )
    .bind(requestFingerprint)
    .first<ContestRunRecord>();

const findLatestPersistedContestRunByFingerprint = async (
  database: D1Database,
  requestFingerprint: string,
) =>
  database
    .prepare(
      `SELECT id, status, contest_url, contest_id
      FROM contest_runs
      WHERE request_fingerprint = ?
        AND contest_url IS NOT NULL
        AND contest_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 1`,
    )
    .bind(requestFingerprint)
    .first<ContestRunRecord>();

export const executeContestCreation = async (
  database: D1Database,
  input: ExecuteContestCreationInput,
) => {
  const existingRun = await findCompletedContestRunByFingerprint(
    database,
    input.requestFingerprint,
  );

  if (existingRun?.contest_url && existingRun.contest_id) {
    return {
      contestId: existingRun.contest_id,
      contestUrl: existingRun.contest_url,
      reused: true,
    };
  }

  const existingPersistedRun = await findLatestPersistedContestRunByFingerprint(
    database,
    input.requestFingerprint,
  );

  if (
    existingPersistedRun?.contest_url &&
    existingPersistedRun.contest_id &&
    existingPersistedRun.status !== "completed"
  ) {
    throw new Error(
      `以前のバチャ作成が部分的に失敗しています。AtCoder Problems 側の状態を確認してください: ${existingPersistedRun.contest_url}`,
    );
  }

  let contestRunId: number | null = null;

  try {
    contestRunId = await insertContestRun(database, {
      dedupeKey: createRunKey(),
      requestFingerprint: input.requestFingerprint,
      startedAt: Date.now(),
    });
    const selectedProblems = await selectProblems({
      database,
      difficultyBands: input.difficultyBands,
      settings: input.settings,
      unsolvedOnly: input.unsolvedOnly,
      userId: input.userId,
    });
    const contestSequence = await reserveNextContestSequence(database);
    const createdContest = await createContest(input.fetchFn ?? fetch, {
      durationSecond: input.durationSecond,
      isPublic: input.isPublic,
      memo: input.memo,
      penaltySecond: input.penaltySecond,
      problems: createContestProblemsPayload(selectedProblems),
      sleepMs: input.atCoderProblemsRequestIntervalMs,
      startEpochSecond: input.startEpochSecond,
      title: createContestTitle(contestSequence),
      token: input.atCoderProblemsToken,
    });

    await updateContestRun(database, {
      contestId: createdContest.contestId,
      contestRunId,
      contestUrl: createdContest.contestUrl,
      status: "completed",
    });

    const bookkeepingResults = await Promise.allSettled([
      insertProblemUsageLogs(database, {
        contestRunId,
        problemIds: selectedProblems.map((problem) => problem.problem_id),
        usedAt: input.startTimeMs,
      }),
      insertCommandLog(database, {
        commandContext: input.commandContext,
        commandName: input.commandName,
        message: createdContest.contestUrl,
        settingsSummary: input.settingsSummary,
        status: "completed",
      }),
    ]);

    for (const result of bookkeepingResults) {
      if (result.status === "rejected") {
        await recordBookkeepingFailure(database, {
          commandContext: input.commandContext,
          commandName: input.commandName,
          contestUrl: createdContest.contestUrl,
          error: result.reason,
          settingsSummary: input.settingsSummary,
        });
      }
    }

    return {
      ...createdContest,
      reused: false,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "バチャ作成に失敗しました。";

    if (contestRunId !== null) {
      await updateContestRun(database, {
        contestId:
          error instanceof PartialContestCreationError
            ? error.contestId
            : undefined,
        contestRunId,
        contestUrl:
          error instanceof PartialContestCreationError
            ? error.contestUrl
            : undefined,
        errorMessage: message,
        status:
          error instanceof PartialContestCreationError
            ? "partial_failed"
            : "failed",
      });
    }

    throw error;
  }
};
