import { describe, expect, it } from "vitest";

import { selectProblems } from "../src/problem-selection/select";

const createSelectionDatabase = () => {
  const problemCatalog = [
    {
      contest_id: "abc100",
      difficulty: 850,
      is_experimental: 0,
      problem_id: "abc100_a",
      problem_index: "A",
      source_category: "ABC",
      title: "A",
    },
    {
      contest_id: "abc100",
      difficulty: 920,
      is_experimental: 0,
      problem_id: "abc100_b",
      problem_index: "B",
      source_category: "ABC",
      title: "B",
    },
    {
      contest_id: "arc100",
      difficulty: 1100,
      is_experimental: 0,
      problem_id: "arc100_c",
      problem_index: "C",
      source_category: "ARC",
      title: "C",
    },
    {
      contest_id: "agc100",
      difficulty: 1250,
      is_experimental: 0,
      problem_id: "agc100_d",
      problem_index: "D",
      source_category: "AGC",
      title: "D",
    },
    {
      contest_id: "arc101",
      difficulty: 1150,
      is_experimental: 0,
      problem_id: "arc101_c",
      problem_index: "C",
      source_category: "ARC",
      title: "Another C",
    },
    {
      contest_id: "abc101",
      difficulty: 870,
      is_experimental: 1,
      problem_id: "abc101_a",
      problem_index: "A",
      source_category: "ABC",
      title: "Experimental A",
    },
  ];
  const solvedProblems = [{ problem_id: "abc100_a" }];
  const recentlyUsedProblems = [{ problem_id: "arc100_c" }];

  return {
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => {
          if (query.includes("FROM solved_problems")) {
            return { results: solvedProblems };
          }

          if (query.includes("FROM problem_usage_logs")) {
            return {
              results: Number(params[0]) > 0 ? recentlyUsedProblems : [],
            };
          }

          return { results: [] };
        },
      }),
      all: async () => {
        if (query.includes("FROM problem_catalog")) {
          return { results: problemCatalog };
        }

        return { results: [] };
      },
    }),
  } as unknown as D1Database;
};

describe("problem selection", () => {
  it("selects problems by difficulty bands after solved and recent exclusions", async () => {
    const selectedProblems = await selectProblems({
      database: createSelectionDatabase(),
      difficultyBands: [
        {
          difficulty_max: 999,
          difficulty_min: 800,
          problem_count: 1,
        },
        {
          difficulty_max: 1199,
          difficulty_min: 1000,
          problem_count: 1,
        },
      ],
      settings: {
        allow_other_sources: 0,
        default_problem_count: 2,
        exclude_recently_used_days: 14,
        include_abc: 1,
        include_agc: 0,
        include_arc: 1,
        include_experimental_difficulty: 0,
      },
      unsolvedOnly: true,
      userId: "tossyhal",
    });

    expect(selectedProblems.map((problem) => problem.problem_id)).toEqual([
      "abc100_b",
      "arc101_c",
    ]);
  });
});
