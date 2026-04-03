import { DurableObject } from "cloudflare:workers";

import { syncProblemCatalog } from "../atcoder-problems/problem-catalog";

type ProblemCatalogSyncEnv = {
  DB: D1Database;
};

const alarmDelayMs = 5000;
const maxAlarmRetries = 3;
const retryCountStorageKey = "retryCount";

export class ProblemCatalogSyncDurableObject extends DurableObject<ProblemCatalogSyncEnv> {
  override async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/refresh") {
      await this.ctx.storage.put(retryCountStorageKey, 0);
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
      await this.ctx.storage.delete(retryCountStorageKey);
    } catch (error) {
      const retryCount =
        ((await this.ctx.storage.get<number>(retryCountStorageKey)) ?? 0) + 1;

      console.error("[problem-catalog-do] alarm failed", {
        error: error instanceof Error ? error.message : error,
        retryCount,
      });

      if (retryCount >= maxAlarmRetries) {
        await this.ctx.storage.delete(retryCountStorageKey);
        return;
      }

      await this.ctx.storage.put(retryCountStorageKey, retryCount);
      await this.ctx.storage.setAlarm(Date.now() + alarmDelayMs);
    }
  }
}
