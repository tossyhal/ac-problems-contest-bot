type SubmissionRecord = {
  epoch_second: number;
  id: number;
  problem_id: string;
  result: string;
};

export type SyncStateRecord = {
  status: string;
  full_sync_completed_at: number | null;
  last_synced_at: number | null;
  last_checkpoint: string | null;
  last_success_checkpoint: string | null;
  last_error: string | null;
};

type SyncBatchOptions = {
  database: D1Database;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  userId: string;
  waitBeforeFetchMs?: number;
};

type SyncBatchResult = {
  batchSize: number;
  lastCheckpoint: string | null;
  status: "completed" | "failed" | "running";
};

const atCoderProblemsApiBaseUrl = "https://kenkoooo.com/atcoder/atcoder-api/v3";

const syncScopePrefix = "submissions";

const defaultSyncState: SyncStateRecord = {
  status: "idle",
  full_sync_completed_at: null,
  last_synced_at: null,
  last_checkpoint: null,
  last_success_checkpoint: null,
  last_error: null,
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const createSubmissionSyncScope = (userId: string) =>
  `${syncScopePrefix}:${userId}`;

export const getSyncState = async (database: D1Database, userId?: string) => {
  if (!userId) {
    return defaultSyncState;
  }

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
    .bind(createSubmissionSyncScope(userId))
    .first<SyncStateRecord>();

  return result ?? defaultSyncState;
};

export const upsertSyncState = async (
  database: D1Database,
  userId: string,
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
      createSubmissionSyncScope(userId),
      syncState.status,
      syncState.full_sync_completed_at,
      syncState.last_synced_at,
      syncState.last_checkpoint,
      syncState.last_success_checkpoint,
      syncState.last_error,
    )
    .run();
};

const createSolvedProblemStatement = (
  database: D1Database,
  syncedAt: number,
  userId: string,
  submission: SubmissionRecord,
) =>
  database
    .prepare(
      `INSERT INTO solved_problems (
        atcoder_user_id,
        problem_id,
        solved_at,
        synced_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(atcoder_user_id, problem_id) DO UPDATE SET
        solved_at = CASE
          WHEN solved_problems.solved_at IS NULL THEN excluded.solved_at
          WHEN excluded.solved_at IS NULL THEN solved_problems.solved_at
          ELSE MIN(solved_problems.solved_at, excluded.solved_at)
        END,
        synced_at = excluded.synced_at`,
    )
    .bind(
      userId,
      submission.problem_id,
      submission.epoch_second * 1000,
      syncedAt,
    );

const upsertSolvedProblems = async (
  database: D1Database,
  userId: string,
  submissions: SubmissionRecord[],
) => {
  const acceptedSubmissions = submissions.filter(
    (submission) => submission.result === "AC",
  );

  if (acceptedSubmissions.length === 0) {
    return;
  }

  const syncedAt = Date.now();
  const statements = acceptedSubmissions.map((submission) =>
    createSolvedProblemStatement(database, syncedAt, userId, submission),
  );

  for (let index = 0; index < statements.length; index += 100) {
    const chunk = statements.slice(index, index + 100);

    if ("batch" in database && typeof database.batch === "function") {
      await database.batch(chunk);
      continue;
    }

    for (const statement of chunk) {
      await statement.run();
    }
  }
};

const fetchUserSubmissions = async (
  fetchFn: typeof fetch,
  fromSecond: number,
  userId: string,
) => {
  const url = new URL(`${atCoderProblemsApiBaseUrl}/user/submissions`);
  url.searchParams.set("user", userId);
  url.searchParams.set("from_second", String(fromSecond));

  const response = await fetchFn(url);

  if (!response.ok) {
    throw new Error(
      `AtCoder Problems submissions API error: ${response.status}`,
    );
  }

  return (await response.json()) as SubmissionRecord[];
};

const getStartFromSecond = (syncState: SyncStateRecord) => {
  const checkpoint = Number(syncState.last_success_checkpoint ?? "0");

  if (!Number.isFinite(checkpoint) || checkpoint < 0) {
    return 0;
  }

  return Math.max(0, checkpoint - 1);
};

const getCompletedAtTimestamp = (
  initialSyncState: SyncStateRecord,
  completedAt: number,
) => initialSyncState.full_sync_completed_at ?? completedAt;

export const markSyncQueued = async (database: D1Database, userId: string) => {
  const currentSyncState = await getSyncState(database, userId);

  await upsertSyncState(database, userId, {
    ...currentSyncState,
    status: "queued",
    last_error: null,
  });
};

export const syncUserSubmissionsBatch = async ({
  database,
  fetchFn = fetch,
  sleepFn = sleep,
  userId,
  waitBeforeFetchMs = 0,
}: SyncBatchOptions): Promise<SyncBatchResult> => {
  const initialSyncState = await getSyncState(database, userId);
  const fromSecond = getStartFromSecond(initialSyncState);
  const previousCheckpoint = initialSyncState.last_success_checkpoint ?? "0";

  await upsertSyncState(database, userId, {
    ...initialSyncState,
    status: "running",
    last_error: null,
  });

  console.log("[sync] batch start", {
    fromSecond,
    userId,
  });

  try {
    if (waitBeforeFetchMs > 0) {
      await sleepFn(waitBeforeFetchMs);
    }

    const submissions = await fetchUserSubmissions(fetchFn, fromSecond, userId);
    const now = Date.now();

    console.log("[sync] batch fetched", {
      count: submissions.length,
      fromSecond,
      userId,
    });

    if (submissions.length === 0) {
      await upsertSyncState(database, userId, {
        status: "completed",
        full_sync_completed_at: getCompletedAtTimestamp(initialSyncState, now),
        last_synced_at: now,
        last_checkpoint: previousCheckpoint,
        last_success_checkpoint: previousCheckpoint,
        last_error: null,
      });

      console.log("[sync] batch completed without new submissions", {
        lastCheckpoint: previousCheckpoint,
        userId,
      });

      return {
        batchSize: 0,
        lastCheckpoint: previousCheckpoint,
        status: "completed",
      };
    }

    await upsertSolvedProblems(database, userId, submissions);

    const maxEpochSecond = submissions.reduce(
      (currentMax, submission) => Math.max(currentMax, submission.epoch_second),
      fromSecond,
    );
    const lastCheckpoint = String(maxEpochSecond);
    const nextStatus = submissions.length < 500 ? "completed" : "running";

    await upsertSyncState(database, userId, {
      status: nextStatus,
      full_sync_completed_at:
        nextStatus === "completed"
          ? getCompletedAtTimestamp(initialSyncState, now)
          : initialSyncState.full_sync_completed_at,
      last_synced_at: now,
      last_checkpoint: lastCheckpoint,
      last_success_checkpoint: lastCheckpoint,
      last_error: null,
    });

    console.log("[sync] batch updated", {
      batchSize: submissions.length,
      lastCheckpoint,
      status: nextStatus,
      userId,
    });

    return {
      batchSize: submissions.length,
      lastCheckpoint,
      status: nextStatus,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "同期に失敗しました。";

    await upsertSyncState(database, userId, {
      status: "failed",
      full_sync_completed_at: initialSyncState.full_sync_completed_at,
      last_synced_at: initialSyncState.last_synced_at,
      last_checkpoint: initialSyncState.last_checkpoint,
      last_success_checkpoint: initialSyncState.last_success_checkpoint,
      last_error: message,
    });

    console.error("[sync] batch failed", {
      error: message,
      fromSecond,
      userId,
    });

    return {
      batchSize: 0,
      lastCheckpoint: initialSyncState.last_success_checkpoint,
      status: "failed",
    };
  }
};
