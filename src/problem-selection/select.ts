type DifficultyBandRecord = {
  difficulty_max: number;
  difficulty_min: number;
  problem_count: number;
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

type ProblemSelectionSettings = {
  allow_other_sources: number;
  default_problem_count: number;
  exclude_recently_used_days: number;
  include_abc: number;
  include_agc: number;
  include_arc: number;
  include_experimental_difficulty: number;
};

type SelectProblemsOptions = {
  database: D1Database;
  difficultyBands: DifficultyBandRecord[];
  settings: ProblemSelectionSettings;
  unsolvedOnly?: boolean;
  userId: null | string;
};

const getProblemCatalog = async (database: D1Database) => {
  const result = await database
    .prepare(
      `SELECT
        problem_id,
        contest_id,
        problem_index,
        title,
        difficulty,
        is_experimental,
        source_category
      FROM problem_catalog`,
    )
    .all<ProblemCatalogRecord>();

  return result.results;
};

const getSolvedProblemIds = async (database: D1Database, userId: string) => {
  const result = await database
    .prepare(
      `SELECT problem_id
      FROM solved_problems
      WHERE atcoder_user_id = ?`,
    )
    .bind(userId)
    .all<{ problem_id: string }>();

  return new Set(result.results.map((record) => record.problem_id));
};

const getRecentlyUsedProblemIds = async (
  database: D1Database,
  excludeRecentlyUsedDays: number,
) => {
  if (excludeRecentlyUsedDays <= 0) {
    return new Set<string>();
  }

  const threshold = Date.now() - excludeRecentlyUsedDays * 24 * 60 * 60 * 1000;
  const result = await database
    .prepare(
      `SELECT DISTINCT problem_id
      FROM problem_usage_logs
      WHERE used_at >= ?`,
    )
    .bind(threshold)
    .all<{ problem_id: string }>();

  return new Set(result.results.map((record) => record.problem_id));
};

const includesSourceCategory = (
  problem: ProblemCatalogRecord,
  settings: ProblemSelectionSettings,
) => {
  switch (problem.source_category) {
    case "ABC":
      return Boolean(settings.include_abc);
    case "ARC":
      return Boolean(settings.include_arc);
    case "AGC":
      return Boolean(settings.include_agc);
    default:
      return Boolean(settings.allow_other_sources);
  }
};

const getRandomInt = (maxExclusive: number) => {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);

  return values[0] % maxExclusive;
};

const shuffleProblems = (problems: ProblemCatalogRecord[]) => {
  const shuffled = [...problems];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = getRandomInt(index + 1);
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  return shuffled;
};

const filterCandidateProblems = (
  problems: ProblemCatalogRecord[],
  options: {
    recentlyUsedProblemIds: Set<string>;
    settings: ProblemSelectionSettings;
    solvedProblemIds: Set<string>;
    unsolvedOnly: boolean;
  },
) =>
  problems
    .filter((problem) => includesSourceCategory(problem, options.settings))
    .filter(
      (problem) =>
        options.settings.include_experimental_difficulty ||
        !problem.is_experimental,
    )
    .filter(
      (problem) => !options.recentlyUsedProblemIds.has(problem.problem_id),
    )
    .filter(
      (problem) =>
        !options.unsolvedOnly ||
        !options.solvedProblemIds.has(problem.problem_id),
    );

const takeProblemsForBand = (
  candidates: ProblemCatalogRecord[],
  selectedProblemIds: Set<string>,
  band: DifficultyBandRecord,
) => {
  const matchingProblems = shuffleProblems(
    candidates.filter(
      (problem) =>
        !selectedProblemIds.has(problem.problem_id) &&
        problem.difficulty !== null &&
        problem.difficulty >= band.difficulty_min &&
        problem.difficulty <= band.difficulty_max,
    ),
  );

  if (matchingProblems.length < band.problem_count) {
    throw new Error(
      `${band.difficulty_min}-${band.difficulty_max} の候補が ${band.problem_count} 問ぶん見つかりませんでした。`,
    );
  }

  return matchingProblems.slice(0, band.problem_count);
};

export const selectProblems = async ({
  database,
  difficultyBands,
  settings,
  unsolvedOnly = true,
  userId,
}: SelectProblemsOptions) => {
  const [problemCatalog, recentlyUsedProblemIds, solvedProblemIds] =
    await Promise.all([
      getProblemCatalog(database),
      getRecentlyUsedProblemIds(database, settings.exclude_recently_used_days),
      userId ? getSolvedProblemIds(database, userId) : new Set<string>(),
    ]);

  const candidates = filterCandidateProblems(problemCatalog, {
    recentlyUsedProblemIds,
    settings,
    solvedProblemIds,
    unsolvedOnly,
  });
  const shuffledCandidates = shuffleProblems(candidates);

  if (difficultyBands.length === 0) {
    if (shuffledCandidates.length < settings.default_problem_count) {
      throw new Error(
        `候補問題が不足しています。必要 ${settings.default_problem_count} 問に対して ${shuffledCandidates.length} 問しかありません。`,
      );
    }

    return shuffledCandidates.slice(0, settings.default_problem_count);
  }

  const selectedProblemIds = new Set<string>();
  const selectedProblems: ProblemCatalogRecord[] = [];

  for (const band of difficultyBands) {
    const bandProblems = takeProblemsForBand(
      shuffledCandidates,
      selectedProblemIds,
      band,
    );

    for (const problem of bandProblems) {
      selectedProblemIds.add(problem.problem_id);
      selectedProblems.push(problem);
    }
  }

  return selectedProblems;
};
