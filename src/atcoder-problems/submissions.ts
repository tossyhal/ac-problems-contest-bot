type SubmissionRecord = {
  epoch_second: number;
  id: number;
  problem_id: string;
  result: string;
};

type SyncStateRecord = {
  status: string;
  full_sync_completed_at: number | null;
  last_synced_at: number | null;
  last_checkpoint: string | null;
  last_success_checkpoint: string | null;
  last_error: string | null;
};

type SyncOptions = {
  database: D1Database;
  userId: string;
  fetchFn?: typeof fetch;
  sleepMs?: number;
};

const atCoderProblemsApiBaseUrl = "https://kenkoooo.com/atcoder/atcoder-api/v3";

const syncScope = "submissions";

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
    .bind(syncScope)
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

const upsertSolvedProblem = async (
  database: D1Database,
  userId: string,
  submission: SubmissionRecord,
) => {
  await database
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
      Date.now(),
    )
    .run();
};

const fetchUserSubmissions = async (
  userId: string,
  fromSecond: number,
  fetchFn: typeof fetch,
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
  if (syncState.full_sync_completed_at) {
    return 0;
  }

  const checkpoint = Number(syncState.last_success_checkpoint ?? "0");

  if (!Number.isFinite(checkpoint) || checkpoint < 0) {
    return 0;
  }

  return Math.max(0, checkpoint - 1);
};

export const syncUserSubmissions = async ({
  database,
  userId,
  fetchFn = fetch,
  sleepMs = 5000,
}: SyncOptions) => {
  const initialSyncState = await getSyncState(database);
  let fromSecond = getStartFromSecond(initialSyncState);

  await upsertSyncState(database, {
    ...initialSyncState,
    status: "running",
    last_error: null,
  });

  let lastCheckpoint = initialSyncState.last_success_checkpoint ?? "0";

  try {
    while (true) {
      const submissions = await fetchUserSubmissions(
        userId,
        fromSecond,
        fetchFn,
      );
      const now = Date.now();

      if (submissions.length === 0) {
        await upsertSyncState(database, {
          status: "completed",
          full_sync_completed_at: now,
          last_synced_at: now,
          last_checkpoint: lastCheckpoint,
          last_success_checkpoint: lastCheckpoint,
          last_error: null,
        });
        return;
      }

      for (const submission of submissions) {
        if (submission.result === "AC") {
          await upsertSolvedProblem(database, userId, submission);
        }
      }

      const maxEpochSecond = submissions.reduce(
        (currentMax, submission) =>
          Math.max(currentMax, submission.epoch_second),
        fromSecond,
      );
      lastCheckpoint = String(maxEpochSecond);

      await upsertSyncState(database, {
        status: "running",
        full_sync_completed_at: null,
        last_synced_at: now,
        last_checkpoint: lastCheckpoint,
        last_success_checkpoint: lastCheckpoint,
        last_error: null,
      });

      if (submissions.length < 500) {
        await upsertSyncState(database, {
          status: "completed",
          full_sync_completed_at: now,
          last_synced_at: now,
          last_checkpoint: lastCheckpoint,
          last_success_checkpoint: lastCheckpoint,
          last_error: null,
        });
        return;
      }

      fromSecond = maxEpochSecond + 1;
      await sleep(sleepMs);
    }
  } catch (error) {
    await upsertSyncState(database, {
      status: "failed",
      full_sync_completed_at: initialSyncState.full_sync_completed_at,
      last_synced_at: initialSyncState.last_synced_at,
      last_checkpoint: lastCheckpoint,
      last_success_checkpoint: lastCheckpoint,
      last_error:
        error instanceof Error ? error.message : "同期に失敗しました。",
    });
    throw error;
  }
};
