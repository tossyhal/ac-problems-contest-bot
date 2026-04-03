import { describe, expect, it } from "vitest";

import {
  getSyncState,
  syncUserSubmissionsBatch,
} from "../src/atcoder-problems/submissions";

const createSubmissionDatabase = (seed?: {
  solvedProblems?: Array<{
    atcoder_user_id: string;
    problem_id: string;
    solved_at: number | null;
    synced_at: number;
  }>;
  syncState?: {
    full_sync_completed_at: number | null;
    last_checkpoint: string | null;
    last_error: string | null;
    last_success_checkpoint: string | null;
    last_synced_at: number | null;
    status: string;
  };
}) => {
  const syncStates: Record<
    string,
    {
      full_sync_completed_at: number | null;
      last_checkpoint: string | null;
      last_error: string | null;
      last_success_checkpoint: string | null;
      last_synced_at: number | null;
      status: string;
    } | null
  > = seed?.syncState
    ? {
        "submissions:tossyhal": seed.syncState,
      }
    : {};
  const solvedProblems = [...(seed?.solvedProblems ?? [])];

  return {
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      for (const statement of statements) {
        await statement.run();
      }

      return [];
    },
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (query.includes("FROM sync_states")) {
            return syncStates[String(params[0])] ?? null;
          }

          return null;
        },
        run: async () => {
          if (query.includes("INSERT INTO sync_states")) {
            syncStates[String(params[0])] = {
              full_sync_completed_at: params[2] as number | null,
              last_checkpoint: params[4] as string | null,
              last_error: params[6] as string | null,
              last_success_checkpoint: params[5] as string | null,
              last_synced_at: params[3] as number | null,
              status: params[1] as string,
            };
          }

          if (query.includes("INSERT INTO solved_problems")) {
            const atcoderUserId = params[0] as string;
            const problemId = params[1] as string;
            const solvedAt = params[2] as number;
            const syncedAt = params[3] as number;
            const existing = solvedProblems.find(
              (record) =>
                record.atcoder_user_id === atcoderUserId &&
                record.problem_id === problemId,
            );

            if (existing) {
              existing.solved_at =
                existing.solved_at === null
                  ? solvedAt
                  : Math.min(existing.solved_at, solvedAt);
              existing.synced_at = syncedAt;
            } else {
              solvedProblems.push({
                atcoder_user_id: atcoderUserId,
                problem_id: problemId,
                solved_at: solvedAt,
                synced_at: syncedAt,
              });
            }
          }

          return { success: true };
        },
        all: async () => {
          if (query.includes("FROM solved_problems")) {
            return { results: solvedProblems };
          }

          return { results: [] };
        },
      }),
    }),
  } as unknown as D1Database;
};

describe("submission sync", () => {
  it("keeps full sync completion timestamp while incremental sync is still running", async () => {
    const completedAt = Date.now() - 60_000;
    const database = createSubmissionDatabase({
      syncState: {
        full_sync_completed_at: completedAt,
        last_checkpoint: "100",
        last_error: null,
        last_success_checkpoint: "100",
        last_synced_at: completedAt,
        status: "completed",
      },
    });

    const result = await syncUserSubmissionsBatch({
      database,
      fetchFn: async () =>
        Response.json(
          Array.from({ length: 500 }, (_, index) => ({
            epoch_second: 101 + index,
            id: index + 1,
            problem_id: `abc100_${index}`,
            result: "WA",
          })),
        ),
      userId: "tossyhal",
    });

    const syncState = await getSyncState(database, "tossyhal");

    expect(result.status).toBe("running");
    expect(syncState.status).toBe("running");
    expect(syncState.full_sync_completed_at).toBe(completedAt);
  });

  it("preserves the original full sync completion timestamp when incremental sync finds no new submissions", async () => {
    const completedAt = Date.now() - 60_000;
    const database = createSubmissionDatabase({
      syncState: {
        full_sync_completed_at: completedAt,
        last_checkpoint: "100",
        last_error: null,
        last_success_checkpoint: "100",
        last_synced_at: completedAt,
        status: "completed",
      },
    });

    const result = await syncUserSubmissionsBatch({
      database,
      fetchFn: async () => Response.json([]),
      userId: "tossyhal",
    });

    const syncState = await getSyncState(database, "tossyhal");

    expect(result.status).toBe("completed");
    expect(syncState.status).toBe("completed");
    expect(syncState.full_sync_completed_at).toBe(completedAt);
  });

  it("preserves the earliest AC timestamp when the same problem is solved again", async () => {
    const firstSolvedAt = 1_700_000_000_000;
    const database = createSubmissionDatabase({
      solvedProblems: [
        {
          atcoder_user_id: "tossyhal",
          problem_id: "abc100_a",
          solved_at: firstSolvedAt,
          synced_at: firstSolvedAt,
        },
      ],
      syncState: {
        full_sync_completed_at: firstSolvedAt,
        last_checkpoint: "100",
        last_error: null,
        last_success_checkpoint: "100",
        last_synced_at: firstSolvedAt,
        status: "completed",
      },
    });

    await syncUserSubmissionsBatch({
      database,
      fetchFn: async () =>
        Response.json([
          {
            epoch_second: Math.floor((firstSolvedAt + 60_000) / 1000),
            id: 1,
            problem_id: "abc100_a",
            result: "AC",
          },
        ]),
      userId: "tossyhal",
    });

    const solved = await database
      .prepare(
        `SELECT problem_id
        FROM solved_problems
        WHERE atcoder_user_id = ?`,
      )
      .bind("tossyhal")
      .all<{
        atcoder_user_id: string;
        problem_id: string;
        solved_at: number;
      }>();

    expect(solved.results).toContainEqual(
      expect.objectContaining({
        problem_id: "abc100_a",
        solved_at: firstSolvedAt,
      }),
    );
  });

  it("splits solved problem upserts into chunks of 100 for D1 batch", async () => {
    const database = createSubmissionDatabase({
      syncState: {
        full_sync_completed_at: null,
        last_checkpoint: "0",
        last_error: null,
        last_success_checkpoint: "0",
        last_synced_at: null,
        status: "idle",
      },
    });
    const batchSizes: number[] = [];
    (
      database as unknown as {
        batch: (
          statements: { run: () => Promise<unknown> }[],
        ) => Promise<unknown[]>;
      }
    ).batch = async (statements) => {
      batchSizes.push(statements.length);

      if (statements.length > 100) {
        throw new Error("too many statements");
      }

      for (const statement of statements) {
        await statement.run();
      }

      return [];
    };

    const result = await syncUserSubmissionsBatch({
      database,
      fetchFn: async () =>
        Response.json(
          Array.from({ length: 500 }, (_, index) => ({
            epoch_second: 1_700_000_000 + index,
            id: index + 1,
            problem_id: `abc100_${index}`,
            result: "AC",
          })),
        ),
      userId: "tossyhal",
    });

    expect(result.status).toBe("running");
    expect(batchSizes).toEqual([100, 100, 100, 100, 100]);
  });

  it("waits before fetching when a retry interval is requested", async () => {
    const database = createSubmissionDatabase({
      syncState: {
        full_sync_completed_at: Date.now(),
        last_checkpoint: "100",
        last_error: null,
        last_success_checkpoint: "100",
        last_synced_at: Date.now(),
        status: "running",
      },
    });
    const sleepCalls: number[] = [];

    await syncUserSubmissionsBatch({
      database,
      fetchFn: async () => Response.json([]),
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
      userId: "tossyhal",
      waitBeforeFetchMs: 5000,
    });

    expect(sleepCalls).toEqual([5000]);
  });

  it("isolates sync state by AtCoder user ID", async () => {
    const completedAt = Date.now() - 60_000;
    const database = createSubmissionDatabase({
      syncState: {
        full_sync_completed_at: completedAt,
        last_checkpoint: "100",
        last_error: null,
        last_success_checkpoint: "100",
        last_synced_at: completedAt,
        status: "completed",
      },
    });

    const oldUserState = await getSyncState(database, "tossyhal");
    const newUserState = await getSyncState(database, "another_user");

    expect(oldUserState.status).toBe("completed");
    expect(oldUserState.full_sync_completed_at).toBe(completedAt);
    expect(newUserState).toEqual({
      full_sync_completed_at: null,
      last_checkpoint: null,
      last_error: null,
      last_success_checkpoint: null,
      last_synced_at: null,
      status: "idle",
    });
  });
});
