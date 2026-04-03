import { DurableObject } from "cloudflare:workers";

import { syncUserSubmissionsBatch } from "../atcoder-problems/submissions";

type SubmissionSyncJob = {
  retryCount: number;
  userId: string;
};

type SubmissionSyncEnv = {
  DB: D1Database;
};

const alarmDelayMs = 5000;
const jobStorageKey = "job";
const maxAlarmRetries = 3;

export class SubmissionSyncDurableObject extends DurableObject<SubmissionSyncEnv> {
  override async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      const body = (await request.json()) as SubmissionSyncJob;

      if (!body.userId) {
        return Response.json(
          {
            error: "userId is required.",
          },
          { status: 400 },
        );
      }

      await this.ctx.storage.put(jobStorageKey, {
        retryCount: 0,
        userId: body.userId,
      });
      await this.ctx.storage.setAlarm(Date.now() + alarmDelayMs);

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
      const job = await this.ctx.storage.get<SubmissionSyncJob>(jobStorageKey);

      if (!job) {
        return;
      }

      console.log("[sync-do] alarm fired", {
        userId: job.userId,
      });

      const result = await syncUserSubmissionsBatch({
        database: this.env.DB,
        userId: job.userId,
      });

      if (result.status === "running") {
        await this.ctx.storage.put(jobStorageKey, {
          ...job,
          retryCount: 0,
        });
        await this.ctx.storage.setAlarm(Date.now() + alarmDelayMs);
        return;
      }

      await this.ctx.storage.delete(jobStorageKey);
    } catch (error) {
      const job = await this.ctx.storage.get<SubmissionSyncJob>(jobStorageKey);
      const retryCount = (job?.retryCount ?? 0) + 1;

      console.error("[sync-do] alarm failed", {
        error: error instanceof Error ? error.message : error,
        retryCount,
      });

      if (!job) {
        return;
      }

      if (retryCount >= maxAlarmRetries) {
        await this.ctx.storage.delete(jobStorageKey);
        return;
      }

      await this.ctx.storage.put(jobStorageKey, {
        ...job,
        retryCount,
      });
      await this.ctx.storage.setAlarm(Date.now() + alarmDelayMs);
    }
  }
}
