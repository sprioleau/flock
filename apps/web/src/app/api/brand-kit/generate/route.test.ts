import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chargeCreditForRequestMock = vi.hoisted(() => vi.fn());
const generateBrandKitMock = vi.hoisted(() => vi.fn());
const afterMock = vi.hoisted(() => vi.fn());
const getTokenMock = vi.hoisted(() => vi.fn());
const convexMutationMock = vi.hoisted(() => vi.fn());
const convexQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/credits", () => ({
  chargeCreditForRequest: chargeCreditForRequestMock,
}));
vi.mock("@/lib/brand-kit-extraction/generate-brand-kit", () => ({
  generateBrandKit: generateBrandKitMock,
}));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/auth/auth-server", () => ({ getToken: getTokenMock }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    mutation = convexMutationMock;
    query = convexQueryMock;
  },
}));

import { maxDuration, POST, runtime } from "./route";

let requestClockMs = Date.UTC(2026, 8, 11, 12, 0, 0);

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/brand-kit/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  requestClockMs += 10_000;
  vi.setSystemTime(requestClockMs);
  chargeCreditForRequestMock.mockReset();
  chargeCreditForRequestMock.mockResolvedValue({
    isAllowed: true,
    isUnlimited: false,
    remaining: 4,
  });
  generateBrandKitMock.mockReset();
  afterMock.mockReset();
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue(null);
  convexMutationMock.mockReset();
  convexMutationMock.mockResolvedValue("job-1");
  convexQueryMock.mockReset();
  convexQueryMock.mockResolvedValue({ kitId: "kit-1" });
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://convex.test";
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/brand-kit/generate — Vercel function contract", () => {
  it("pins browser-backed generation to Node with enough time for rendering and Gemini", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBeGreaterThanOrEqual(180);
  });

  it("charges once, creates a durable job, and schedules generation after responding", async () => {
    const brandKit = { name: "Acme", sourceUrl: "https://acme.test/" };
    generateBrandKitMock.mockResolvedValue({ isOk: true, brandKit });

    const request = makeRequest({ url: "acme.test", sessionId: "session-1" });
    const response = await POST(request);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ isOk: true, jobId: "job-1" });
    expect(chargeCreditForRequestMock).toHaveBeenCalledTimes(1);
    expect(chargeCreditForRequestMock).toHaveBeenCalledWith({
      request,
      isMockRun: true,
    });
    expect(generateBrandKitMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);
    await afterMock.mock.calls[0]?.[0]();
    expect(generateBrandKitMock).toHaveBeenCalledWith({
      url: "https://acme.test",
      onProgress: expect.any(Function),
    });
    expect(convexQueryMock).toHaveBeenCalled();
  });

  it("records a generator failure on the durable job", async () => {
    generateBrandKitMock.mockResolvedValue({
      isOk: false,
      statusCode: 422,
      message: "We couldn't read enough of that website.",
    });

    const response = await POST(makeRequest({ url: "https://acme.test", sessionId: "session-1" }));

    expect(response.status).toBe(202);
    await afterMock.mock.calls[0]?.[0]();
    expect(generateBrandKitMock).toHaveBeenCalledTimes(1);
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobId: "job-1",
        errorMessage: "We couldn't read enough of that website.",
      }),
    );
  });

  it.each(["http://127.0.0.1/admin", "javascript:alert(1)", "not a website"])(
    "rejects the unsafe or malformed URL %s before charging or generating",
    async (url) => {
      const response = await POST(makeRequest({ url, sessionId: "session-1" }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        isOk: false,
        message: "Please provide a public website address (like your-brand.com).",
      });
      expect(chargeCreditForRequestMock).not.toHaveBeenCalled();
      expect(generateBrandKitMock).not.toHaveBeenCalled();
    },
  );
});
