import { createContest } from "../atcoder-problems/contest";
import { insertCommandLog } from "../db/command-log";

type ContestProblemPayload = {
  id: string;
  order: number;
  point: number;
};

type ExecuteContestCreationInput = {
  atCoderProblemsToken: string;
  commandContext?: string;
  commandName: "custom-start" | "start";
  durationSecond: number;
  fetchFn?: typeof fetch;
  isPublic: boolean;
  memo: string;
  penaltySecond: number;
  problemIds: string[];
  problems: ContestProblemPayload[];
  requestFingerprint: string;
  settingsSummary: string;
  startEpochSecond: number;
  startTimeMs: number;
  title: string;
};

type ContestRunRecord = {
  contest_id: null | string;
  contest_url: null | string;
  id: number;
  status: string;
};

const createRunKey = () => `${Date.now()}:${crypto.randomUUID()}`;

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

  let contestRunId: number | null = null;

  try {
    contestRunId = await insertContestRun(database, {
      dedupeKey: createRunKey(),
      requestFingerprint: input.requestFingerprint,
      startedAt: Date.now(),
    });
    const createdContest = await createContest(input.fetchFn ?? fetch, {
      durationSecond: input.durationSecond,
      isPublic: input.isPublic,
      memo: input.memo,
      penaltySecond: input.penaltySecond,
      problems: input.problems,
      sleepMs: input.fetchFn ? 0 : undefined,
      startEpochSecond: input.startEpochSecond,
      title: input.title,
      token: input.atCoderProblemsToken,
    });

    await Promise.all([
      updateContestRun(database, {
        contestId: createdContest.contestId,
        contestRunId,
        contestUrl: createdContest.contestUrl,
        status: "completed",
      }),
      insertProblemUsageLogs(database, {
        contestRunId,
        problemIds: input.problemIds,
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

    return {
      ...createdContest,
      reused: false,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "バチャ作成に失敗しました。";

    if (contestRunId !== null) {
      await updateContestRun(database, {
        contestRunId,
        errorMessage: message,
        status: "failed",
      });
    }

    await insertCommandLog(database, {
      commandContext: input.commandContext,
      commandName: input.commandName,
      message,
      status: "failed",
    });

    throw error;
  }
};
