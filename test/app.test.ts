import { describe, expect, it } from "vitest";

import { app } from "../src/app";

describe("app", () => {
  it("returns health status", async () => {
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves an openapi document", async () => {
    const response = await app.request("http://localhost/doc");
    const body = (await response.json()) as {
      info: { title: string };
      openapi: string;
      paths: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("ac-problems-contest-bot API");
    expect(body.paths["/health"]).toBeDefined();
  });

  it("serves the scalar reference page", async () => {
    const response = await app.request("http://localhost/reference");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("ac-problems-contest-bot API Reference");
    expect(body).toContain("/doc");
  });
});
