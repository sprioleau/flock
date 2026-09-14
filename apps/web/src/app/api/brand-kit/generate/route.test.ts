import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chargeCreditForRequestMock = vi.hoisted(() => vi.fn());
const generateBrandKitMock = vi.hoisted(() => vi.fn());
const rehostSourceImagesMock = vi.hoisted(() => vi.fn());
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
vi.mock("@/lib/brand-kit-extraction/rehost-source-images", () => ({
  rehostSourceImages: rehostSourceImagesMock,
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
  rehostSourceImagesMock.mockReset();
  rehostSourceImagesMock.mockResolvedValue([]);
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
    const brandKit = {
      name: "Acme",
      sourceUrl: "https://acme.test/",
      emailDesignDoc: { markdown: "# Acme email design", origin: "agent" as const },
    };
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
    expect(convexMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "session-1",
        brandKit: expect.objectContaining({ emailDesignDoc: brandKit.emailDesignDoc }),
      }),
    );
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

  it("persists only durable rehosted source images before completing the job", async () => {
    const sourceImages = [
      { url: "https://acme.test/hero.png", alt: "Acme product" },
      { url: "https://acme.test/broken.png", alt: "Broken source" },
    ];
    generateBrandKitMock.mockResolvedValue({
      isOk: true,
      brandKit: {
        name: "Acme",
        sourceUrl: "https://acme.test/",
        sourceImages,
      },
    });
    rehostSourceImagesMock.mockResolvedValue([
      {
        sourceImage: sourceImages[0],
        url: "https://convex.test/storage/hero.png",
      },
    ]);

    const response = await POST(makeRequest({ url: "acme.test", sessionId: "session-1" }));
    expect(response.status).toBe(202);
    await afterMock.mock.calls[0]?.[0]();

    expect(rehostSourceImagesMock).toHaveBeenCalledWith({
      sourceImages,
      rehost: expect.any(Function),
    });
    const saveCall = convexMutationMock.mock.calls.find(
      (call) => call[1]?.brandKit !== undefined,
    );
    expect(saveCall?.[1].brandKit.sourceImages).toEqual([
      {
        url: "https://convex.test/storage/hero.png",
        alt: "Acme product",
      },
    ]);
  });

  it("uploads and registers a guarded source image as a scraped library asset", async () => {
    const sourceImage = {
      url: "https://acme.test/hero.png",
      alt: "Acme product",
    };
    generateBrandKitMock.mockResolvedValue({
      isOk: true,
      brandKit: {
        name: "Acme",
        sourceUrl: "https://acme.test/",
        sourceImages: [sourceImage],
      },
    });
    convexMutationMock.mockImplementation(async (_reference, args) => {
      if (Object.keys(args).length === 0) {
        return "https://upload.convex.test";
      }
      if (args.kind === "scraped") {
        return { url: "https://convex.test/storage/hero.png" };
      }
      return "job-1";
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ storageId: "storage-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    rehostSourceImagesMock.mockImplementation(async ({ sourceImages, rehost }) => {
      const url = await rehost({
        sourceImage: sourceImages[0],
        binary: { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" },
      });
      return [{ sourceImage: sourceImages[0], url }];
    });

    try {
      const response = await POST(makeRequest({ url: "acme.test", sessionId: "session-1" }));
      expect(response.status).toBe(202);
      await afterMock.mock.calls[0]?.[0]();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://upload.convex.test",
        expect.objectContaining({ method: "POST" }),
      );
      expect(convexMutationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionId: "session-1",
          storageId: "storage-1",
          kind: "scraped",
          name: "Acme product",
          alt: "Acme product",
          sourceUrl: sourceImage.url,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
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
