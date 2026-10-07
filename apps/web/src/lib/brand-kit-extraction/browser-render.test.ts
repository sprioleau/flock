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
  const evaluate = vi.fn(async function evaluate<Result>(): Promise<Result> {
    evaluateCallCount += 1;
    if (evaluateCallCount % 5 === 4) {
      return { width: 1280, height: 1200, captureHeight: 1200 } as Result;
    }
    if (evaluateCallCount % 5 === 0) {
      return createEvidence() as Result;
    }
    if (evaluateCallCount % 5 === 3) {
      return { title: "Example", text: "Rendered site content", hasHtmlRoot: true } as Result;
    }
    return undefined as Result;
  });
  const popup = {
    close: vi.fn(async () => undefined),
  };
  const contexts: Array<{ newPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
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
    connected: true,
    shouldUseDefaultContextOnly: false,
    newPage: vi.fn(async () => page),
    on: vi.fn(),
    off: vi.fn(),
    createBrowserContext: vi.fn(async () => {
      const context = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => undefined),
      };
      contexts.push(context);
      return context;
    }),
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
      launchBrowser: vi.fn(async () => browser as never),
      guardUrl: guard,
    },
  };

  return { browser, contexts, guard, options, page, popup, requests };
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
    expect(harness.browser.close).not.toHaveBeenCalled();
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
    expect(harness.guard).toHaveBeenCalledOnce();
  });

  it("rejects a private final URL even if a browser does not expose an intercepted redirect", async () => {
    const harness = createHarness({ finalUrl: "http://127.0.0.1/private" });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "blocked_host" });
    expect(harness.page.screenshot).not.toHaveBeenCalled();
  });

  it("preserves the final path after a same-origin redirect", async () => {
    const harness = createHarness({ finalUrl: "https://example.com/app/dashboard" });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: true, finalUrl: "https://example.com/app/dashboard" });
  });

  it("rejects URL credentials before launching the browser", async () => {
    const harness = createHarness();

    const result = await renderPageInBrowser("https://user:secret@example.com/page", harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "invalid_url" });
    expect(harness.options.dependencies?.launchBrowser).not.toHaveBeenCalled();
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
    expect(harness.browser.close).not.toHaveBeenCalled();
  });

  it("closes a context that resolves after the render deadline", async () => {
    const harness = createHarness();
    const lateContext = {
      newPage: vi.fn(async () => harness.page),
      close: vi.fn(async () => undefined),
    };
    harness.browser.createBrowserContext.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(lateContext), 30)),
    );

    const result = await renderPageInBrowser(PUBLIC_URL, {
      ...harness.options,
      timeoutMs: 8,
      settleTimeoutMs: 8,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(result).toMatchObject({ isOk: false, reason: "timeout" });
    expect(lateContext.close).toHaveBeenCalledOnce();
  });

  it("closes a browser that launches after the render deadline", async () => {
    const harness = createHarness();
    harness.options.dependencies!.launchBrowser = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return harness.browser as never;
    }) as unknown as NonNullable<BrowserRenderOptions["dependencies"]>["launchBrowser"];

    const result = await renderPageInBrowser(PUBLIC_URL, {
      ...harness.options,
      timeoutMs: 8,
      navigationTimeoutMs: 8,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(result).toMatchObject({ isOk: false, reason: "timeout" });
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("closes a serverless browser that launches after the render deadline", async () => {
    const harness = createHarness();
    harness.browser.shouldUseDefaultContextOnly = true;
    harness.options.dependencies!.launchBrowser = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return harness.browser as never;
    }) as unknown as NonNullable<BrowserRenderOptions["dependencies"]>["launchBrowser"];

    const result = await renderPageInBrowser(PUBLIC_URL, {
      ...harness.options,
      timeoutMs: 8,
      navigationTimeoutMs: 8,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(result).toMatchObject({ isOk: false, reason: "timeout" });
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("closes a serverless browser when default-page creation fails", async () => {
    const harness = createHarness();
    harness.browser.shouldUseDefaultContextOnly = true;
    harness.browser.newPage = vi.fn(async () => {
      throw new Error("Protocol error (Target.createTarget): Target closed");
    });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "browser_unavailable" });
    expect(harness.browser.createBrowserContext).not.toHaveBeenCalled();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("closes a page that resolves after the render deadline", async () => {
    const harness = createHarness();
    const latePage = { ...harness.page, close: vi.fn(async () => undefined) };
    const lateContext = {
      newPage: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(latePage as never), 30))),
      close: vi.fn(async () => undefined),
    };
    harness.browser.createBrowserContext.mockResolvedValueOnce(lateContext as never);

    const result = await renderPageInBrowser(PUBLIC_URL, {
      ...harness.options,
      timeoutMs: 16,
      settleTimeoutMs: 8,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(result).toMatchObject({ isOk: false, reason: "timeout" });
    expect(latePage.close).toHaveBeenCalledOnce();
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

  it("creates and closes a fresh context for each render", async () => {
    const harness = createHarness();
    const firstResult = await renderPageInBrowser(PUBLIC_URL, harness.options);
    const secondResult = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(firstResult.isOk).toBe(true);
    expect(secondResult.isOk).toBe(true);
    expect(harness.browser.createBrowserContext).toHaveBeenCalledTimes(2);
    expect(harness.contexts).toHaveLength(2);
    expect(harness.contexts[0]).not.toBe(harness.contexts[1]);
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(harness.contexts[1]?.close).toHaveBeenCalledOnce();
  });

  it("uses a fresh default-context browser for the serverless Chromium runtime", async () => {
    const harness = createHarness();
    harness.browser.shouldUseDefaultContextOnly = true;
    harness.browser.newPage = vi.fn(async () => harness.page);
    harness.browser.createBrowserContext.mockRejectedValue(
      new Error("Protocol error (Target.createTarget): Target closed"),
    );

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: true });
    expect(harness.browser.newPage).toHaveBeenCalledOnce();
    expect(harness.browser.createBrowserContext).not.toHaveBeenCalled();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "challenge", text: "Checking your browser captcha", reason: "challenge_page" },
    { label: "blocked page", text: "Access denied", reason: "blocked_page" },
    { label: "empty document", text: "", reason: "non_html" },
  ])("refuses a $label instead of reporting success", async ({ text, reason }) => {
    const harness = createHarness();
    (harness.page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      title: text,
      text,
      hasHtmlRoot: text !== "",
    }));

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: false, reason });
    expect(harness.page.screenshot).not.toHaveBeenCalled();
  });

  it("refuses a non-HTML navigation response", async () => {
    const harness = createHarness();
    harness.page.goto.mockResolvedValue({
      status: () => 200,
      headers: () => ({ "content-type": "application/pdf" }),
    });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: false, reason: "non_html" });
    expect(harness.page.screenshot).not.toHaveBeenCalled();
  });

  it("allows ordinary pages that mention CAPTCHA and waits for client-rendered content", async () => {
    const harness = createHarness();
    (harness.page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const callCount = harness.page.evaluate.mock.calls.length;
      if (callCount === 3) {
        return {
          title: "Security research",
          text: "This article explains how CAPTCHA systems affect sign-in design.",
          hasHtmlRoot: true,
          hasVisibleContent: true,
        };
      }
      if (callCount === 4) return { width: 1280, height: 1200, captureHeight: 1200 };
      if (callCount === 5) return createEvidence();
      return undefined;
    });

    const result = await renderPageInBrowser(PUBLIC_URL, harness.options);

    expect(result).toMatchObject({ isOk: true });
    expect(harness.page.evaluate).toHaveBeenCalledTimes(5);
  });
});
