type ContestProblemRecord = {
  contest_id: string;
  problem_id: string;
};

type MergedProblemRecord = {
  contest_id?: string;
  id: string;
  problem_index?: string;
  title: string;
};

type ProblemCatalogRecord = {
  contest_id: string;
  difficulty: null | number;
  is_experimental: number;
  problem_id: string;
  problem_index: null | string;
  source_category: string;
  title: string;
};

type ProblemModelRecord = {
  difficulty?: number;
  is_experimental?: boolean;
};

type SyncProblemCatalogOptions = {
  database: D1Database;
  fetchFn?: typeof fetch;
  sleepMs?: number;
};

const atCoderProblemsResourceBaseUrl = "https://kenkoooo.com/atcoder/resources";
const problemCatalogSyncScope = "problem_catalog";
const staleAfterMs = 24 * 60 * 60 * 1000;

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const fetchJson = async <T>(fetchFn: typeof fetch, resourcePath: string) => {
  const response = await fetchFn(
    `${atCoderProblemsResourceBaseUrl}/${resourcePath}`,
  );

  if (!response.ok) {
    throw new Error(
      `AtCoder Problems resource API error: ${response.status} (${resourcePath})`,
    );
  }

  return (await response.json()) as T;
};

export const getProblemCatalogSyncState = async (database: D1Database) => {
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
    .bind(problemCatalogSyncScope)
    .first<{
      full_sync_completed_at: null | number;
      last_checkpoint: null | string;
      last_error: null | string;
      last_success_checkpoint: null | string;
      last_synced_at: null | number;
      status: string;
    }>();

  return (
    result ?? {
      full_sync_completed_at: null,
      last_checkpoint: null,
      last_error: null,
      last_success_checkpoint: null,
      last_synced_at: null,
      status: "idle",
    }
  );
};

const upsertProblemCatalogSyncState = async (
  database: D1Database,
  syncState: {
    full_sync_completed_at: null | number;
    last_checkpoint: null | string;
    last_error: null | string;
    last_success_checkpoint: null | string;
    last_synced_at: null | number;
    status: string;
  },
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
      problemCatalogSyncScope,
      syncState.status,
      syncState.full_sync_completed_at,
      syncState.last_synced_at,
      syncState.last_checkpoint,
      syncState.last_success_checkpoint,
      syncState.last_error,
    )
    .run();
};

const classifySourceCategory = (contestId: string) => {
  const normalized = contestId.toLowerCase();

  if (normalized.startsWith("abc")) {
    return "ABC";
  }

  if (normalized.startsWith("arc")) {
    return "ARC";
  }

  if (normalized.startsWith("agc")) {
    return "AGC";
  }

  return "OTHER";
};

const mergeProblemCatalog = (
  contestProblems: ContestProblemRecord[],
  mergedProblems: MergedProblemRecord[],
  problemModels: Record<string, ProblemModelRecord>,
) => {
  const contestIdByProblemId = new Map(
    contestProblems.map((record) => [record.problem_id, record.contest_id]),
  );

  return mergedProblems
    .map((problem) => {
      const contestId =
        problem.contest_id ?? contestIdByProblemId.get(problem.id) ?? null;

      if (!contestId) {
        return null;
      }

      const model = problemModels[problem.id];

      return {
        contest_id: contestId,
        difficulty:
          typeof model?.difficulty === "number"
            ? Math.round(model.difficulty)
            : null,
        is_experimental: Number(Boolean(model?.is_experimental)),
        problem_id: problem.id,
        problem_index: problem.problem_index ?? null,
        source_category: classifySourceCategory(contestId),
        title: problem.title,
      } satisfies ProblemCatalogRecord;
    })
    .filter((problem): problem is ProblemCatalogRecord => problem !== null);
};

const getExistingProblemIds = async (database: D1Database) => {
  const result = await database
    .prepare("SELECT problem_id FROM problem_catalog")
    .all<{ problem_id: string }>();

  return result.results.map((record) => record.problem_id);
};

const deleteProblemCatalogEntries = async (
  database: D1Database,
  problemIds: string[],
) => {
  if (problemIds.length === 0) {
    return;
  }

  for (let index = 0; index < problemIds.length; index += 100) {
    const chunk = problemIds.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const statement = database.prepare(
      `DELETE FROM problem_catalog WHERE problem_id IN (${placeholders})`,
    );

    await statement.bind(...chunk).run();
  }
};

const replaceProblemCatalog = async (
  database: D1Database,
  catalog: ProblemCatalogRecord[],
) => {
  const nextProblemIds = new Set(catalog.map((problem) => problem.problem_id));

  for (let index = 0; index < catalog.length; index += 100) {
    const batch = catalog.slice(index, index + 100);
    const statements = batch.map((problem) =>
      database
        .prepare(
          `INSERT INTO problem_catalog (
            problem_id,
            contest_id,
            problem_index,
            title,
            difficulty,
            is_experimental,
            source_category,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(problem_id) DO UPDATE SET
            contest_id = excluded.contest_id,
            problem_index = excluded.problem_index,
            title = excluded.title,
            difficulty = excluded.difficulty,
            is_experimental = excluded.is_experimental,
            source_category = excluded.source_category,
            updated_at = excluded.updated_at`,
        )
        .bind(
          problem.problem_id,
          problem.contest_id,
          problem.problem_index,
          problem.title,
          problem.difficulty,
          problem.is_experimental,
          problem.source_category,
          Date.now(),
        ),
    );

    if ("batch" in database && typeof database.batch === "function") {
      await database.batch(statements);
      continue;
    }

    for (const statement of statements) {
      await statement.run();
    }
  }

  const existingProblemIds = await getExistingProblemIds(database);
  const staleProblemIds = existingProblemIds.filter(
    (problemId) => !nextProblemIds.has(problemId),
  );

  await deleteProblemCatalogEntries(database, staleProblemIds);
};

export const getProblemCatalogStats = async (database: D1Database) => {
  const result = await database
    .prepare("SELECT COUNT(*) AS count FROM problem_catalog")
    .first<{ count: number | string }>();

  return Number(result?.count ?? 0);
};

export const isProblemCatalogStale = async (database: D1Database) => {
  const [syncState, count] = await Promise.all([
    getProblemCatalogSyncState(database),
    getProblemCatalogStats(database),
  ]);

  if (syncState.status === "queued" || syncState.status === "running") {
    return false;
  }

  if (count === 0 || !syncState.last_synced_at) {
    return true;
  }

  return Date.now() - syncState.last_synced_at >= staleAfterMs;
};

export const syncProblemCatalog = async ({
  database,
  fetchFn = fetch,
  sleepMs = 5000,
}: SyncProblemCatalogOptions) => {
  const previousState = await getProblemCatalogSyncState(database);

  await upsertProblemCatalogSyncState(database, {
    ...previousState,
    last_error: null,
    status: "running",
  });

  try {
    const mergedProblems = await fetchJson<MergedProblemRecord[]>(
      fetchFn,
      "merged-problems.json",
    );
    await sleep(sleepMs);
    const problemModels = await fetchJson<Record<string, ProblemModelRecord>>(
      fetchFn,
      "problem-models.json",
    );
    await sleep(sleepMs);
    const contestProblems = await fetchJson<ContestProblemRecord[]>(
      fetchFn,
      "contest-problem.json",
    );

    const mergedCatalog = mergeProblemCatalog(
      contestProblems,
      mergedProblems,
      problemModels,
    );
    await replaceProblemCatalog(database, mergedCatalog);

    const now = Date.now();
    await upsertProblemCatalogSyncState(database, {
      full_sync_completed_at: now,
      last_checkpoint: String(mergedCatalog.length),
      last_error: null,
      last_success_checkpoint: String(mergedCatalog.length),
      last_synced_at: now,
      status: "completed",
    });

    return {
      count: mergedCatalog.length,
      status: "completed" as const,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "問題カタログ同期に失敗しました。";

    await upsertProblemCatalogSyncState(database, {
      full_sync_completed_at: previousState.full_sync_completed_at,
      last_checkpoint: previousState.last_checkpoint,
      last_error: message,
      last_success_checkpoint: previousState.last_success_checkpoint,
      last_synced_at: previousState.last_synced_at,
      status: "failed",
    });

    throw error;
  }
};
