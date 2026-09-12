import { describe, expect, it, vi } from "vitest";

import {
  renderPageInBrowser,
  type BrowserRenderOptions,
  type BrowserVisualEvidence,
} from "./browser-render";

const PUBLIC_URL = "https://example.com/page";

interface FakeRequest {
  url(): string;
  resourceType(): string;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

function createEvidence(): BrowserVisualEvidence {
  return {
    viewport: { width: 1280, height: 1200 },
    document: { width: 1280, height: 1200 },
    colors: [{ value: "rgb(12, 23, 34)", count: 8 }],
    fonts: [{ family: "Inter", weight: "600", count: 4 }],
    elements: [],
    syntheticCss: ":root { --observed-color-1: rgb(12, 23, 34); }",
  };
}

function createHarness({
  finalUrl = PUBLIC_URL,
  requestUrls = [PUBLIC_URL],
  goto,
  screenshot = new Uint8Array([1, 2, 3]),
  shouldOpenPopup = false,
}: {
  finalUrl?: string;
  requestUrls?: string[];
  goto?: () => Promise<unknown>;
  screenshot?: Uint8Array;
  shouldOpenPopup?: boolean;
} = {}) {
  let requestListener: ((request: FakeRequest) => void) | undefined;
  let popupListener: ((popup: { close(): Promise<void> }) => void) | undefined;
  let evaluateCallCount = 0;
  const requests = requestUrls.map((url) => ({
    rawUrl: url,
    hasContinued: false,
    hasAborted: false,
  }));
  async function evaluate<Result>(): Promise<Result> {
    evaluateCallCount += 1;
    if (evaluateCallCount === 3) {
      return { width: 1280, height: 1200, captureHeight: 1200 } as Result;
    }
    if (evaluateCallCount === 4) {
      return createEvidence() as Result;
    }
    return undefined as Result;
  }
  const popup = {
    close: vi.fn(async () => undefined),
  };
  const page = {
    setViewport: vi.fn(async () => undefined),
    setRequestInterception: vi.fn(async () => undefined),
    setBypassServiceWorker: vi.fn(async () => undefined),
    evaluateOnNewDocument: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: (value: never) => void) => {
      if (event === "request") {
        requestListener = listener as unknown as (request: FakeRequest) => void;
      } else if (event === "popup") {
        popupListener = listener as unknown as (popup: { close(): Promise<void> }) => void;
      }
    }),
    off: vi.fn(),
    goto: vi.fn(async () => {
      for (const requestState of requests) {
        const request: FakeRequest = {
          url: () => requestState.rawUrl,
          resourceType: () => "document",
          continue: vi.fn(async () => {
            requestState.hasContinued = true;
          }),
          abort: vi.fn(async () => {
            requestState.hasAborted = true;
          }),
        };
        requestListener?.(request);
      }
      await Promise.resolve();
      await Promise.resolve();
      if (shouldOpenPopup) {
        popupListener?.(popup);
      }
      return goto?.();
    }),
    waitForNetworkIdle: vi.fn(async () => undefined),
    evaluate,
    content: vi.fn(async () => "<html><body>Rendered application</body></html>"),
    url: vi.fn(() => finalUrl),
    screenshot: vi.fn(async () => screenshot),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const guard = vi.fn(async (rawUrl: string) => {
    const url = new URL(rawUrl);
    return url.hostname === "127.0.0.1"
      ? { isAllowed: false as const, reason: "That address points at a private network." }
      : { isAllowed: true as const, url };
  });
  const options: BrowserRenderOptions = {
    dependencies: {
      launchBrowser: vi.fn(async () => browser),
      guardUrl: guard,
    },
  };

  return { browser, guard, options, page, popup, requests };
}

describe("renderPageInBrowser", () => {
  it("returns rendered HTML, a bounded screenshot, and computed visual evidence", async () => {
    const harness = createHarness();

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({
      isOk: true,
      html: "<html><body>Rendered application</body></html>",
      finalUrl: PUBLIC_URL,
      screenshot: {
        mediaType: "image/jpeg",
        width: 1280,
        height: 1200,
        byteLength: 3,
      },
      visualEvidence: {
        colors: [{ value: "rgb(12, 23, 34)", count: 8 }],
      },
    });
    expect(harness.page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 1280, height: 1200 },
      }),
    );
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
    expect(harness.guard).toHaveBeenCalledOnce();
    expect(harness.page.setBypassServiceWorker).toHaveBeenCalledWith(true);
  });

  it("closes popups so a new window cannot make requests outside page interception", async () => {
    const harness = createHarness({ shouldOpenPopup: true });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: true });
    expect(harness.popup.close).toHaveBeenCalledOnce();
  });

  it("rejects a private initial URL before launching a browser", async () => {
    const harness = createHarness();

    const result = await renderPageInBrowser("http://127.0.0.1/admin", harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_host" });
    expect(harness.options.dependencies?.launchBrowser).not.toHaveBeenCalled();
  });

  it("aborts a private browser request instead of allowing a redirect to escape the guard", async () => {
    const harness = createHarness({
      requestUrls: [PUBLIC_URL, "http://127.0.0.1/metadata"],
      goto: async () => {
        throw new Error("Navigation aborted");
      },
    });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_host" });
    expect(harness.requests[0]).toMatchObject({ hasContinued: true, hasAborted: false });
    expect(harness.requests[1]).toMatchObject({ hasContinued: false, hasAborted: true });
    expect(harness.guard).toHaveBeenCalledTimes(2);
  });

  it("rejects a private final URL even if a browser does not expose an intercepted redirect", async () => {
    const harness = createHarness({ finalUrl: "http://127.0.0.1/private" });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_host" });
    expect(harness.page.screenshot).not.toHaveBeenCalled();
  });

  it("returns a soft timeout failure and always closes the page and browser", async () => {
    const harness = createHarness({
      goto: () => new Promise(() => undefined),
    });

    const result = await renderPageInBrowser(PUBLIC_URL, {
      ...harness.options,
      timeoutMs: 20,
      navigationTimeoutMs: 20,
    });

    expect(result).toMatchObject({ isOk: false, reason: "timeout" });
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("fails rather than truncating a screenshot that remains over the byte cap", async () => {
    const harness = createHarness({ screenshot: new Uint8Array([1, 2, 3, 4]) });

    const result = await renderPageInBrowser(PUBLIC_URL, {
      ...harness.options,
      maxScreenshotBytes: 3,
    });

    expect(result).toMatchObject({ isOk: false, reason: "capture_failed" });
    expect(harness.page.screenshot).toHaveBeenCalledTimes(2);
  });
});
