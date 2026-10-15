import { describe, expect, test } from "bun:test";
import { answerFetchBridge } from "./fetch-bridge.js";

const req = (url: string) => ({ type: "inlay-illustrator:fetch-request" as const, requestId: "r1", url });

describe("fetch bridge", () => {
  test("refuses non-API URLs", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => { calls.push(url); return new Response("x"); }) as unknown as typeof fetch;
    expect((await answerFetchBridge(req("https://evil.example/api/x"), fake)).error).toContain("not allowed");
    expect((await answerFetchBridge(req("/api/../secret"), fake)).error).toContain("not allowed");
    expect(calls).toEqual([]);
  });
  test("returns json and HTTP errors", async () => {
    const fake = (async (url: string) => url.endsWith("/missing") ? new Response("no", { status: 404 }) : Response.json({ a: 1 })) as unknown as typeof fetch;
    expect(await answerFetchBridge(req("/api/v1/characters/c/gallery"), fake)).toMatchObject({ requestId: "r1", json: { a: 1 } });
    expect(await answerFetchBridge(req("/api/v1/missing"), fake)).toMatchObject({ error: "HTTP 404", status: 404 });
  });
});
