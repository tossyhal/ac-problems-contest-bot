import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

import { createDiscordInteractionHandler } from "./discord/handler";

export type Env = {
  Bindings: {
    ATCODER_PROBLEMS_TOKEN?: string;
    DB: D1Database;
    DISCORD_PUBLIC_KEY?: string;
    PROBLEM_CATALOG_SYNC?: DurableObjectNamespace;
    SUBMISSION_SYNC?: DurableObjectNamespace;
  };
};

export const app = new OpenAPIHono<Env>();

const healthResponseSchema = z
  .object({
    ok: z.boolean().openapi({
      example: true,
    }),
  })
  .openapi("HealthResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: healthResponseSchema,
        },
      },
    },
  },
});

app.get("/", (c) => c.text("ac-problems-contest-bot"));

app.openapi(healthRoute, (c) => c.json({ ok: true }, 200));

// Discord interaction は署名検証付きの webhook 受け口として扱うため、
// 現時点では公開 OpenAPI には載せない。
app.post("/discord/interactions", async (c) => {
  const handler = createDiscordInteractionHandler(
    c.env?.ATCODER_PROBLEMS_TOKEN,
    c.env?.DISCORD_PUBLIC_KEY,
    c.env?.DB,
    c.env?.PROBLEM_CATALOG_SYNC,
    c.env?.SUBMISSION_SYNC,
  );

  return handler(c.req.raw);
});

app.doc("/doc", {
  openapi: "3.1.0",
  info: {
    title: "ac-problems-contest-bot API",
    version: "0.1.0",
    description: "OpenAPI document for local development.",
  },
});

app.get(
  "/reference",
  apiReference({
    pageTitle: "ac-problems-contest-bot API Reference",
    url: "/doc",
  }),
);
