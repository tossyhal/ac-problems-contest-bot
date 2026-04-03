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
  userId: string;
};

type SyncBatchResult = {
  batchSize: number;
  lastCheckpoint: string | null;
  status: "completed" | "failed" | "running";
};

const atCoderProblemsApiBaseUrl = "https://kenkoooo.com/atcoder/atcoder-api/v3";

const syncScope = "submissions";

const defaultSyncState: SyncStateRecord = {
  status: "idle",
  full_sync_completed_at: null,
  last_synced_at: null,
  last_checkpoint: null,
  last_success_checkpoint: null,
  last_error: null,
};

export const getSyncState = async (database: D1Database) => {
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
    .bind(syncScope)
    .first<SyncStateRecord>();

  return result ?? defaultSyncState;
};

export const upsertSyncState = async (
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
      syncScope,
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
        solved_at = excluded.solved_at,
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

  if ("batch" in database && typeof database.batch === "function") {
    await database.batch(statements);
    return;
  }

  for (const statement of statements) {
    await statement.run();
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

export const markSyncQueued = async (database: D1Database) => {
  const currentSyncState = await getSyncState(database);

  await upsertSyncState(database, {
    ...currentSyncState,
    status: "queued",
    last_error: null,
  });
};

export const syncUserSubmissionsBatch = async ({
  database,
  fetchFn = fetch,
  userId,
}: SyncBatchOptions): Promise<SyncBatchResult> => {
  const initialSyncState = await getSyncState(database);
  const fromSecond = getStartFromSecond(initialSyncState);
  const previousCheckpoint = initialSyncState.last_success_checkpoint ?? "0";

  await upsertSyncState(database, {
    ...initialSyncState,
    status: "running",
    last_error: null,
  });

  console.log("[sync] batch start", {
    fromSecond,
    userId,
  });

  try {
    const submissions = await fetchUserSubmissions(fetchFn, fromSecond, userId);
    const now = Date.now();

    console.log("[sync] batch fetched", {
      count: submissions.length,
      fromSecond,
      userId,
    });

    if (submissions.length === 0) {
      await upsertSyncState(database, {
        status: "completed",
        full_sync_completed_at: now,
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

    await upsertSyncState(database, {
      status: nextStatus,
      full_sync_completed_at:
        nextStatus === "completed"
          ? now
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

    await upsertSyncState(database, {
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
