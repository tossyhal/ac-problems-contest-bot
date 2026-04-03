type CreateContestInput = {
  durationSecond: number;
  isPublic: boolean;
  memo: string;
  penaltySecond: number;
  problems: {
    id: string;
    order: number;
    point: number;
  }[];
  startEpochSecond: number;
  title: string;
  token: string;
  sleepMs?: number;
};

type CreateContestResponse = {
  contest_id: string;
};

const contestBaseUrl = "https://kenkoooo.com/atcoder";
const atCoderProblemsRequestIntervalMs = 5000;

const createHeaders = (token: string) => ({
  Cookie: `token=${token}`,
  "Content-Type": "application/json",
});

const ensureOk = async (response: Response, route: string) => {
  if (response.ok) {
    return;
  }

  const body = await response.text();

  throw new Error(`${route} failed: ${response.status} ${body}`);
};

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createContest = async (
  fetchFn: typeof fetch,
  input: CreateContestInput,
) => {
  const createResponse = await fetchFn(
    `${contestBaseUrl}/internal-api/contest/create`,
    {
      method: "POST",
      headers: createHeaders(input.token),
      body: JSON.stringify({
        title: input.title,
        memo: input.memo,
        start_epoch_second: input.startEpochSecond,
        duration_second: input.durationSecond,
        mode: null,
        is_public: input.isPublic,
        penalty_second: input.penaltySecond,
      }),
    },
  );
  await ensureOk(createResponse, "contest/create");
  const createBody = (await createResponse.json()) as CreateContestResponse;
  await sleep(input.sleepMs ?? atCoderProblemsRequestIntervalMs);

  const updateResponse = await fetchFn(
    `${contestBaseUrl}/internal-api/contest/item/update`,
    {
      method: "POST",
      headers: createHeaders(input.token),
      body: JSON.stringify({
        contest_id: createBody.contest_id,
        problems: input.problems,
      }),
    },
  );
  await ensureOk(updateResponse, "contest/item/update");

  return {
    contestId: createBody.contest_id,
    contestUrl: `${contestBaseUrl}/#/contest/show/${createBody.contest_id}`,
  };
};
