import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBrandKitFromUrl } from "./brand-kit-generate-client";

/*
  The one client entry to POST /api/brand-kit/generate, shared by the brand
  kit panel and the brand-first onboarding gate. Two things are load-bearing:

  1. THE REQUEST CARRIES EXACTLY THE URL THE CALLER TYPED — no other fields,
     since the route (not the browser) owns normalization and the credit
     charge.
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
      jsonResponse({ isOk: true, brandKit: { name: "Acme" } }),
    );
    await generateBrandKitFromUrl("acme.com");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/brand-kit/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ url: "acme.com" });
  });
});

describe("the outcome", () => {
  it("hands back the generated kit on success", async () => {
    stubFetch(() => jsonResponse({ isOk: true, brandKit: { name: "Acme" } }));
    const result = await generateBrandKitFromUrl("acme.com");
    expect(result).toEqual({ isOk: true, brandKit: { name: "Acme" } });
  });

  it("keeps the route's own refusal message — it saw the failure, the browser didn't", async () => {
    stubFetch(() =>
      jsonResponse({ isOk: false, message: "That site blocked our scan." }, 422),
    );
    const result = await generateBrandKitFromUrl("blocked.example");
    expect(result).toEqual({ isOk: false, message: "That site blocked our scan." });
  });

  it("fails honestly, with friendly words, when the network never answers", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    const result = await generateBrandKitFromUrl("acme.com");
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
