import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chargeCreditForRequestMock = vi.hoisted(() => vi.fn());
const generateBrandKitMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/credits", () => ({
  chargeCreditForRequest: chargeCreditForRequestMock,
}));
vi.mock("@/lib/brand-kit-extraction/generate-brand-kit", () => ({
  generateBrandKit: generateBrandKitMock,
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
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/brand-kit/generate — Vercel function contract", () => {
  it("pins browser-backed generation to Node with enough time for rendering and Gemini", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBeGreaterThanOrEqual(180);
  });

  it("charges once, generates once, and preserves the successful response contract", async () => {
    const brandKit = { name: "Acme", sourceUrl: "https://acme.test/" };
    generateBrandKitMock.mockResolvedValue({ isOk: true, brandKit });

    const request = makeRequest({ url: "acme.test" });
    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ isOk: true, brandKit });
    expect(chargeCreditForRequestMock).toHaveBeenCalledTimes(1);
    expect(chargeCreditForRequestMock).toHaveBeenCalledWith({
      request,
      isMockRun: true,
    });
    expect(generateBrandKitMock).toHaveBeenCalledTimes(1);
    expect(generateBrandKitMock).toHaveBeenCalledWith({ url: "https://acme.test" });
  });

  it("preserves generator failure status and message", async () => {
    generateBrandKitMock.mockResolvedValue({
      isOk: false,
      statusCode: 422,
      message: "We couldn't read enough of that website.",
    });

    const response = await POST(makeRequest({ url: "https://acme.test" }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      isOk: false,
      message: "We couldn't read enough of that website.",
    });
    expect(generateBrandKitMock).toHaveBeenCalledTimes(1);
  });

  it.each(["http://127.0.0.1/admin", "javascript:alert(1)", "not a website"])(
    "rejects the unsafe or malformed URL %s before charging or generating",
    async (url) => {
      const response = await POST(makeRequest({ url }));

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
