import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBrandKitFromUrl } from "./brand-kit-generate-client";

/*
  The one client entry to POST /api/brand-kit/generate, shared by the brand
  kit panel and the brand-first onboarding gate. Two things are load-bearing:

  1. THE REQUEST CARRIES THE URL THE CALLER TYPED plus the session that owns
     the durable background job. The route still owns normalization.
  2. AN UNREACHABLE ROUTE STILL RESOLVES, WITH WORDS — a caller left holding
     a rejected promise shows a spinner that never stops.
*/

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(respond: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the request", () => {
  it("posts exactly the typed url to the generate route", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ isOk: true, jobId: "job-1" }),
    );
    await generateBrandKitFromUrl({ url: "acme.com", sessionId: "session-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/brand-kit/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ url: "acme.com", sessionId: "session-1" });
  });
});

describe("the outcome", () => {
  it("hands back the durable job id on success", async () => {
    stubFetch(() => jsonResponse({ isOk: true, jobId: "job-1" }, 202));
    const result = await generateBrandKitFromUrl({ url: "acme.com", sessionId: "session-1" });
    expect(result).toEqual({ isOk: true, jobId: "job-1" });
  });

  it("keeps the route's own refusal message — it saw the failure, the browser didn't", async () => {
    stubFetch(() =>
      jsonResponse({ isOk: false, message: "That site blocked our scan." }, 422),
    );
    const result = await generateBrandKitFromUrl({ url: "blocked.example", sessionId: "session-1" });
    expect(result).toEqual({ isOk: false, message: "That site blocked our scan." });
  });

  it("fails honestly, with friendly words, when the network never answers", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    const result = await generateBrandKitFromUrl({ url: "acme.com", sessionId: "session-1" });
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
