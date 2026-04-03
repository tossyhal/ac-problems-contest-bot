import { DurableObject } from "cloudflare:workers";

import { syncProblemCatalog } from "../atcoder-problems/problem-catalog";

type ProblemCatalogSyncEnv = {
  DB: D1Database;
};

export class ProblemCatalogSyncDurableObject extends DurableObject<ProblemCatalogSyncEnv> {
  override async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/refresh") {
      await this.ctx.storage.setAlarm(Date.now());

      return Response.json({
        status: "queued",
      });
    }

    return Response.json(
      {
        error: "Unsupported Durable Object request.",
      },
      { status: 404 },
    );
  }

  override async alarm() {
    try {
      console.log("[problem-catalog-do] alarm fired");
      await syncProblemCatalog({
        database: this.env.DB,
      });
    } catch (error) {
      console.error("[problem-catalog-do] alarm failed", {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }
}
