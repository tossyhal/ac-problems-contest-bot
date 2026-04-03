import { DurableObject } from "cloudflare:workers";

import {
  type ExecuteContestCreationInput,
  executeContestCreation,
} from "../contest-creation/service";

type ContestCreationEnv = {
  ATCODER_PROBLEMS_TOKEN?: string;
  DB: D1Database;
};

type ContestCreationRequest = Omit<
  ExecuteContestCreationInput,
  "atCoderProblemsToken" | "fetchFn"
>;

export class ContestCreationGuardDurableObject extends DurableObject<ContestCreationEnv> {
  override async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/create") {
      return Response.json(
        {
          error: "Unsupported Durable Object request.",
        },
        { status: 404 },
      );
    }

    if (!this.env.ATCODER_PROBLEMS_TOKEN) {
      return Response.json(
        {
          error: "ATCODER_PROBLEMS_TOKEN is not configured.",
        },
        { status: 500 },
      );
    }

    const body = (await request.json()) as ContestCreationRequest;
    const result = await executeContestCreation(this.env.DB, {
      ...body,
      atCoderProblemsToken: this.env.ATCODER_PROBLEMS_TOKEN,
    });

    return Response.json(result);
  }
}
