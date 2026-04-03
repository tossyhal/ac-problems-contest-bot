import { describe, expect, it } from "vitest";

import { createContest } from "../src/atcoder-problems/contest";
import {
  executeContestCreation,
  findCompletedContestRunByFingerprint,
} from "../src/contest-creation/service";

const createContestDatabase = (options?: {
  failCommandLog?: boolean;
  failProblemUsageLogs?: boolean;
}) => {
  let nextContestSequence = 1;
  const contestRuns: Array<Record<string, unknown>> = [];
  const commandLogs: Array<Record<string, unknown>> = [];
  const problemUsageLogs: Array<Record<string, unknown>> = [];

  return {
    __state: {
      commandLogs,
      contestRuns,
      problemUsageLogs,
    },
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      for (const statement of statements) {
        await statement.run();
      }

      return [];
    },
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (
            query.includes("FROM contest_runs") &&
            query.includes("status = 'completed'")
          ) {
            return (
              contestRuns.find(
                (record) =>
                  record.request_fingerprint === params[0] &&
                  record.status === "completed",
              ) ?? null
            );
          }

          return null;
        },
        all: async () => {
          if (query.includes("FROM solved_problems")) {
            return { results: [] };
          }

          if (query.includes("FROM problem_usage_logs")) {
            return { results: [] };
          }

          return { results: [] };
        },
        run: async () => {
          if (query.includes("INSERT INTO contest_runs")) {
            const id = contestRuns.length + 1;
            contestRuns.push({
              contest_id: null,
              contest_url: null,
              dedupe_key: params[1],
              id,
              request_fingerprint: params[0],
              started_at: params[3],
              status: params[2],
            });

            return {
              meta: {
                last_row_id: id,
              },
              success: true,
            };
          }

          if (query.includes("UPDATE contest_runs")) {
            const run = contestRuns.find((record) => record.id === params[4]);

            if (run) {
              run.status = params[0];
              run.contest_url = params[1];
              run.contest_id = params[2];
              run.error_message = params[3];
            }

            return { success: true };
          }

          if (query.includes("INSERT INTO problem_usage_logs")) {
            if (options?.failProblemUsageLogs) {
              throw new Error("problem usage log failure");
            }

            problemUsageLogs.push({
              contest_run_id: params[2],
              problem_id: params[0],
              used_at: params[1],
            });

            return { success: true };
          }

          if (query.includes("INSERT INTO command_logs")) {
            if (options?.failCommandLog) {
              throw new Error("command log failure");
            }

            commandLogs.push({
              command_name: params[0],
              command_context: params[1],
              status: params[2],
              settings_summary: params[3],
              message: params[4],
            });

            return { success: true };
          }

          return { success: true };
        },
      }),
      first: async () => {
        if (
          query.includes("UPDATE settings") &&
          query.includes(
            "RETURNING next_contest_sequence - 1 AS contest_sequence",
          )
        ) {
          const contestSequence = nextContestSequence;
          nextContestSequence += 1;

          return {
            contest_sequence: contestSequence,
          };
        }

        return null;
      },
      all: async () => {
        if (query.includes("FROM problem_catalog")) {
          return {
            results: [
              {
                contest_id: "abc100",
                difficulty: 850,
                is_experimental: 0,
                problem_id: "abc100_a",
                problem_index: "A",
                source_category: "ABC",
                title: "A",
              },
            ],
          };
        }

        return { results: [] };
      },
    }),
  } as unknown as D1Database;
};

describe("contest creation", () => {
  it("rejects contest creation responses without contest_id", async () => {
    await expect(
      createContest(
        async (input: RequestInfo | URL) => {
          const url = String(input);

          if (url.endsWith("/internal-api/contest/create")) {
            return Response.json({});
          }

          throw new Error(`Unexpected fetch: ${url}`);
        },
        {
          durationSecond: 600,
          isPublic: false,
          memo: "",
          penaltySecond: 300,
          problems: [],
          sleepMs: 0,
          startEpochSecond: 1_700_000_000,
          title: "test",
          token: "token",
        },
      ),
    ).rejects.toThrow("contest/create failed: missing contest_id");
  });

  it("keeps completed runs reusable even when post-create bookkeeping fails", async () => {
    const database = createContestDatabase({
      failCommandLog: true,
    });

    const result = await executeContestCreation(database, {
      atCoderProblemsToken: "token",
      commandName: "start",
      difficultyBands: [],
      durationSecond: 600,
      fetchFn: async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith("/internal-api/contest/create")) {
          return Response.json({
            contest_id: "contest-123",
          });
        }

        if (url.endsWith("/internal-api/contest/item/update")) {
          return new Response(null, {
            status: 200,
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      isPublic: false,
      memo: "",
      penaltySecond: 300,
      requestFingerprint: "fingerprint-1",
      settings: {
        allow_other_sources: 0,
        default_problem_count: 1,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 0,
        include_experimental_difficulty: 0,
        next_contest_sequence: 1,
      },
      settingsSummary: "{}",
      startEpochSecond: 1_700_000_000,
      startTimeMs: 1_700_000_000_000,
      unsolvedOnly: true,
      userId: "tossyhal",
    });

    expect(result).toEqual(
      expect.objectContaining({
        contestId: "contest-123",
        reused: false,
      }),
    );

    await expect(
      findCompletedContestRunByFingerprint(database, "fingerprint-1"),
    ).resolves.toEqual(
      expect.objectContaining({
        contest_id: "contest-123",
        contest_url: "https://kenkoooo.com/atcoder/#/contest/show/contest-123",
        status: "completed",
      }),
    );
  });
});
