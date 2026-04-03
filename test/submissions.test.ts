import { describe, expect, it } from "vitest";

import {
  getSyncState,
  syncUserSubmissionsBatch,
} from "../src/atcoder-problems/submissions";

const createSubmissionDatabase = (seed?: {
  syncState?: {
    full_sync_completed_at: number | null;
    last_checkpoint: string | null;
    last_error: string | null;
    last_success_checkpoint: string | null;
    last_synced_at: number | null;
    status: string;
  };
}) => {
  let syncState = seed?.syncState ?? null;

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
            return syncState;
          }

          return null;
        },
        run: async () => {
          if (query.includes("INSERT INTO sync_states")) {
            syncState = {
              full_sync_completed_at: params[2] as number | null,
              last_checkpoint: params[4] as string | null,
              last_error: params[6] as string | null,
              last_success_checkpoint: params[5] as string | null,
              last_synced_at: params[3] as number | null,
              status: params[1] as string,
            };
          }

          return { success: true };
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

    const syncState = await getSyncState(database);

    expect(result.status).toBe("running");
    expect(syncState.status).toBe("running");
    expect(syncState.full_sync_completed_at).toBe(completedAt);
  });
});
