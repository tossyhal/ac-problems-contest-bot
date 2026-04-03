import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export type Env = {
  Bindings: {
    DB: D1Database;
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
