import { access } from "node:fs/promises";

import { logRecord } from "../observability/log";
import { guardUrl, type UrlGuardResult } from "./url-guard";

const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const DEFAULT_MAX_CAPTURE_HEIGHT = 2000;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 12_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_REQUESTS = 180;
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
const SCREENSHOT_MEDIA_TYPE = "image/jpeg" as const;
const DEFAULT_CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v152.0.0/chromium-v152.0.0-pack.x64.tar";

type BrowserRenderFailureReason =
  | "invalid_url"
  | "blocked_host"
  | "dns"
  | "browser_unavailable"
  | "timeout"
  | "navigation_failed"
  | "capture_failed";

export interface BrowserVisualEvidence {
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  colors: Array<{ value: string; count: number }>;
  fonts: Array<{ family: string; weight: string; count: number }>;
  elements: Array<{
    tag: string;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    backgroundColor: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    borderRadius: string;
  }>;
  syntheticCss: string;
}

export interface BrowserScreenshot {
  mediaType: typeof SCREENSHOT_MEDIA_TYPE;
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  byteLength: number;
}

export interface BrowserRenderSuccess {
  isOk: true;
  html: string;
  finalUrl: string;
  screenshot: BrowserScreenshot;
  visualEvidence: BrowserVisualEvidence;
  requestCount: number;
}

export interface BrowserRenderFailure {
  isOk: false;
  reason: BrowserRenderFailureReason;
  message: string;
}

export type BrowserRenderResult = BrowserRenderSuccess | BrowserRenderFailure;

interface BrowserRequestLike {
  url(): string;
  resourceType(): string;
  isInterceptResolutionHandled?(): boolean;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

interface PageLike {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  setRequestInterception(value: boolean): Promise<void>;
  setBypassServiceWorker(value: boolean): Promise<void>;
  evaluateOnNewDocument(pageFunction: unknown): Promise<unknown>;
  on(event: "request", listener: (request: BrowserRequestLike) => void): void;
  on(event: "popup", listener: (popup: PageLike) => void): void;
  off?(event: "request", listener: (request: BrowserRequestLike) => void): void;
  off?(event: "popup", listener: (popup: PageLike) => void): void;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  waitForNetworkIdle(options: { idleTime: number; timeout: number }): Promise<void>;
  evaluate<Result>(pageFunction: unknown, ...args: unknown[]): Promise<Result>;
  content(): Promise<string>;
  url(): string;
  screenshot(options: {
    type: "jpeg";
    quality: number;
    clip: { x: number; y: number; width: number; height: number };
    captureBeyondViewport: boolean;
  }): Promise<Uint8Array | string>;
  close(): Promise<void>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface BrowserRenderDependencies {
  launchBrowser(options: BrowserRenderOptions): Promise<BrowserLike>;
  guardUrl(rawUrl: string): Promise<UrlGuardResult>;
  now(): number;
}

export interface BrowserRenderOptions {
  timeoutMs?: number;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxCaptureHeight?: number;
  maxRequests?: number;
  maxHtmlBytes?: number;
  maxScreenshotBytes?: number;
  chromiumPackUrl?: string;
  dependencies?: Partial<BrowserRenderDependencies>;
}

class BrowserRenderDeadlineError extends Error {
  constructor() {
    super("Browser rendering exceeded its deadline.");
    this.name = "BrowserRenderDeadlineError";
  }
}

function failure(reason: BrowserRenderFailureReason, message: string): BrowserRenderFailure {
  return { isOk: false, reason, message };
}

function getGuardFailure(result: Extract<UrlGuardResult, { isAllowed: false }>): BrowserRenderFailure {
  const isDnsFailure = result.reason.includes("look up");
  return failure(
    isDnsFailure ? "dns" : result.reason.includes("valid URL") ? "invalid_url" : "blocked_host",
    isDnsFailure
      ? "We couldn't find that site — please double-check the address."
      : "We can only render public http and https websites.",
  );
}

async function withDeadline<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<Value>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new BrowserRenderDeadlineError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function remainingTimeout(
  deadline: { atMs: number; now(): number },
  capMs: number,
): number {
  return Math.max(1, Math.min(capMs, deadline.atMs - deadline.now()));
}

function getGuardCacheKey(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return rawUrl;
  }
}

function createCachedGuard(
  guard: (rawUrl: string) => Promise<UrlGuardResult>,
): (rawUrl: string) => Promise<UrlGuardResult> {
  const guardByOrigin = new Map<string, Promise<UrlGuardResult>>();
  return function guardWithOriginCache(rawUrl: string): Promise<UrlGuardResult> {
    const cacheKey = getGuardCacheKey(rawUrl);
    const cached = guardByOrigin.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const pending = guard(rawUrl);
    guardByOrigin.set(cacheKey, pending);
    return pending;
  };
}

async function findLocalChromeExecutable(): Promise<string | null> {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /*
        Continue through the known browser locations. A missing candidate is
        expected and should not turn browser discovery into a failure.
      */
    }
  }
  return null;
}

async function launchDefaultBrowser(options: BrowserRenderOptions): Promise<BrowserLike> {
  const puppeteer = await import("puppeteer-core");
  const localExecutablePath = await findLocalChromeExecutable();

  if (localExecutablePath !== null) {
    return (await puppeteer.launch({
      executablePath: localExecutablePath,
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
    })) as unknown as BrowserLike;
  }

  const chromiumModule = await import("@sparticuz/chromium-min");
  const chromium = chromiumModule.default;
  const chromiumPackUrl = options.chromiumPackUrl ?? DEFAULT_CHROMIUM_PACK_URL;
  const executablePath = await chromium.executablePath(chromiumPackUrl);

  return (await puppeteer.launch({
    executablePath,
    args: chromium.args,
    headless: "shell",
  })) as unknown as BrowserLike;
}

function installStableRenderingStyles(): void {
  const style = document.createElement("style");
  style.setAttribute("data-flock-browser-render", "true");
  style.textContent = `
    *, *::before, *::after {
      animation-delay: 0s !important;
      animation-duration: 0s !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
      transition-delay: 0s !important;
      transition-duration: 0s !important;
    }
  `;
  document.documentElement.appendChild(style);
}

async function settleRenderedPage(): Promise<void> {
  installStableRenderingStyles();
  if (document.fonts !== undefined) {
    await document.fonts.ready;
  }
}

async function triggerLazyContent(maxScrollY: number): Promise<void> {
  const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
  for (let y = 0; y <= maxScrollY; y += step) {
    window.scrollTo(0, y);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  }
  window.scrollTo(0, 0);
}

function collectDocumentDimensions(maxCaptureHeight: number): {
  width: number;
  height: number;
  captureHeight: number;
} {
  const body = document.body;
  const root = document.documentElement;
  const width = Math.max(body?.scrollWidth ?? 0, root.scrollWidth, root.clientWidth);
  const height = Math.max(body?.scrollHeight ?? 0, root.scrollHeight, root.clientHeight);
  return {
    width,
    height,
    captureHeight: Math.max(1, Math.min(maxCaptureHeight, height)),
  };
}

function collectVisualEvidenceInPage(maxCaptureHeight: number): BrowserVisualEvidence {
  const colorCounts = new Map<string, number>();
  const fontCounts = new Map<string, { family: string; weight: string; count: number }>();
  const elements: BrowserVisualEvidence["elements"] = [];
  const candidates = Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 1400);

  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || rect.bottom < 0 || rect.top > maxCaptureHeight) {
      continue;
    }
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      continue;
    }
    for (const colorValue of [style.color, style.backgroundColor, style.borderTopColor]) {
      const normalizedColor = colorValue.trim().toLowerCase();
      if (
        normalizedColor.length === 0 ||
        normalizedColor === "transparent" ||
        normalizedColor === "rgba(0, 0, 0, 0)"
      ) {
        continue;
      }
      colorCounts.set(normalizedColor, (colorCounts.get(normalizedColor) ?? 0) + 1);
    }

    const fontKey = `${style.fontFamily}|${style.fontWeight}`;
    const existingFont = fontCounts.get(fontKey);
    fontCounts.set(fontKey, {
      family: style.fontFamily,
      weight: style.fontWeight,
      count: (existingFont?.count ?? 0) + 1,
    });

    if (
      elements.length < 32 &&
      /^(A|BUTTON|FOOTER|H1|H2|H3|HEADER|IMG|MAIN|NAV|SECTION)$/.test(element.tagName)
    ) {
      elements.push({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
        x: Math.round(rect.x),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        borderRadius: style.borderRadius,
      });
    }
  }

  const colors = Array.from(colorCounts, ([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 24);
  const fonts = Array.from(fontCounts.values())
    .sort((left, right) => right.count - left.count)
    .slice(0, 12);
  const documentWidth = Math.max(document.body?.scrollWidth ?? 0, document.documentElement.scrollWidth);
  const documentHeight = Math.max(
    document.body?.scrollHeight ?? 0,
    document.documentElement.scrollHeight,
  );
  const syntheticCss = [
    ":root {",
    ...colors.slice(0, 12).map((color, index) => `  --observed-color-${index + 1}: ${color.value};`),
    ...fonts
      .slice(0, 6)
      .map((font, index) => `  --observed-font-${index + 1}: ${font.family};`),
    "}",
  ].join("\n");

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: { width: documentWidth, height: documentHeight },
    colors,
    fonts,
    elements,
    syntheticCss,
  };
}

function toScreenshotBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "base64") : value;
}

async function closeQuietly(resource: { close(): Promise<void> } | null): Promise<void> {
  if (resource === null) {
    return;
  }
  await withDeadline(resource.close(), 1000).catch(() => undefined);
}

async function renderWithBrowser({
  rawUrl,
  options,
  dependencies,
  deadlineAtMs,
}: {
  rawUrl: string;
  options: BrowserRenderOptions;
  dependencies: BrowserRenderDependencies;
  deadlineAtMs: number;
}): Promise<BrowserRenderResult> {
  const deadline = { atMs: deadlineAtMs, now: dependencies.now };
  const guardBrowserUrl = createCachedGuard(dependencies.guardUrl);
  const initialGuard = await withDeadline(
    guardBrowserUrl(rawUrl),
    remainingTimeout(deadline, DEFAULT_SETTLE_TIMEOUT_MS),
  );
  if (!initialGuard.isAllowed) {
    return getGuardFailure(initialGuard);
  }

  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const maxCaptureHeight = Math.min(
    DEFAULT_MAX_CAPTURE_HEIGHT,
    Math.max(1, options.maxCaptureHeight ?? DEFAULT_MAX_CAPTURE_HEIGHT),
  );
  const maxRequests = Math.max(1, options.maxRequests ?? DEFAULT_MAX_REQUESTS);
  const maxHtmlBytes = Math.max(1, options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES);
  const maxScreenshotBytes = Math.max(
    1,
    options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES,
  );
  let browser: BrowserLike | null = null;
  let page: PageLike | null = null;
  let requestCount = 0;
  let blockedNavigationReason: BrowserRenderFailure | null = null;
  let requestListener: ((request: BrowserRequestLike) => void) | null = null;
  let popupListener: ((popup: PageLike) => void) | null = null;
  let stage = "launch";

  try {
    try {
      browser = await withDeadline(
        dependencies.launchBrowser(options),
        remainingTimeout(deadline, navigationTimeoutMs),
      );
      page = await withDeadline(
        browser.newPage(),
        remainingTimeout(deadline, settleTimeoutMs),
      );
    } catch (error) {
      if (error instanceof BrowserRenderDeadlineError) {
        throw error;
      }
      return failure(
        "browser_unavailable",
        "The browser renderer is unavailable right now. Flock can continue with its standard page reader.",
      );
    }

    await withDeadline(
      page.setViewport({
        width: DEFAULT_VIEWPORT_WIDTH,
        height: DEFAULT_VIEWPORT_HEIGHT,
        deviceScaleFactor: 1,
      }),
      remainingTimeout(deadline, settleTimeoutMs),
    );
    stage = "install_stable_styles";
    await withDeadline(
      page.evaluateOnNewDocument(installStableRenderingStyles),
      remainingTimeout(deadline, settleTimeoutMs),
    );
    stage = "intercept_requests";
    await withDeadline(
      page.setRequestInterception(true),
      remainingTimeout(deadline, settleTimeoutMs),
    );
    await withDeadline(
      page.setBypassServiceWorker(true),
      remainingTimeout(deadline, settleTimeoutMs),
    );

    /*
      Every render launches a fresh browser process, so cookies, storage, and
      service-worker state cannot leak between users or captures. Popups are
      closed immediately so their traffic cannot escape page interception.
    */
    popupListener = (popup) => {
      void closeQuietly(popup);
    };
    page.on("popup", popupListener);

    requestListener = (request) => {
      void (async () => {
        if (request.isInterceptResolutionHandled?.() === true) {
          return;
        }
        requestCount += 1;
        const isOverRequestBudget = requestCount > maxRequests;
        const isMedia = request.resourceType() === "media";
        if (isOverRequestBudget || isMedia) {
          await request.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        const requestGuard = await guardBrowserUrl(request.url());
        if (!requestGuard.isAllowed) {
          if (request.resourceType() === "document") {
            blockedNavigationReason = getGuardFailure(requestGuard);
          }
          await request.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        await request.continue().catch(() => undefined);
      })();
    };
    page.on("request", requestListener);

    try {
      stage = "navigate";
      const navigationTimeout = remainingTimeout(deadline, navigationTimeoutMs);
      await withDeadline(
        page.goto(initialGuard.url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        }),
        navigationTimeout,
      );
    } catch (error) {
      if (blockedNavigationReason !== null) {
        return blockedNavigationReason;
      }
      if (
        error instanceof BrowserRenderDeadlineError ||
        (error instanceof Error && error.name === "TimeoutError") ||
        dependencies.now() >= deadlineAtMs
      ) {
        throw new BrowserRenderDeadlineError();
      }
      return failure("navigation_failed", "That page couldn't finish loading in the browser.");
    }

    const finalGuard = await withDeadline(
      guardBrowserUrl(page.url()),
      remainingTimeout(deadline, settleTimeoutMs),
    );
    if (!finalGuard.isAllowed) {
      return getGuardFailure(finalGuard);
    }

    const networkIdleTimeout = remainingTimeout(deadline, settleTimeoutMs);
    stage = "settle_network";
    await withDeadline(
      page.waitForNetworkIdle({ idleTime: 500, timeout: networkIdleTimeout }),
      networkIdleTimeout,
    ).catch(() => undefined);
    stage = "settle_page";
    await withDeadline(
      page.evaluate<void>(settleRenderedPage),
      remainingTimeout(deadline, settleTimeoutMs),
    ).catch(() => undefined);
    stage = "lazy_scroll";
    await withDeadline(
      page.evaluate<void>(triggerLazyContent, maxCaptureHeight),
      remainingTimeout(deadline, settleTimeoutMs),
    ).catch(() => undefined);

    stage = "capture_html";
    const html = (
      await withDeadline(
        page.content(),
        remainingTimeout(deadline, settleTimeoutMs),
      )
    ).slice(0, maxHtmlBytes);
    stage = "measure_document";
    const dimensions = await withDeadline(
      page.evaluate<{
        width: number;
        height: number;
        captureHeight: number;
      }>(collectDocumentDimensions, maxCaptureHeight),
      remainingTimeout(deadline, settleTimeoutMs),
    );
    stage = "resize_for_capture";
    await withDeadline(
      page.setViewport({
        width: DEFAULT_VIEWPORT_WIDTH,
        height: dimensions.captureHeight,
        deviceScaleFactor: 1,
      }),
      remainingTimeout(deadline, settleTimeoutMs),
    );

    stage = "capture_screenshot";
    let screenshotBytes = toScreenshotBytes(
      await withDeadline(
        page.screenshot({
          type: "jpeg",
          quality: 62,
          clip: {
            x: 0,
            y: 0,
            width: DEFAULT_VIEWPORT_WIDTH,
            height: dimensions.captureHeight,
          },
          captureBeyondViewport: false,
        }),
        remainingTimeout(deadline, settleTimeoutMs),
      ),
    );
    if (screenshotBytes.byteLength > maxScreenshotBytes) {
      screenshotBytes = toScreenshotBytes(
        await withDeadline(
          page.screenshot({
            type: "jpeg",
            quality: 35,
            clip: {
              x: 0,
              y: 0,
              width: DEFAULT_VIEWPORT_WIDTH,
              height: dimensions.captureHeight,
            },
            captureBeyondViewport: false,
          }),
          remainingTimeout(deadline, settleTimeoutMs),
        ),
      );
    }
    if (screenshotBytes.byteLength > maxScreenshotBytes) {
      return failure("capture_failed", "The rendered page image was too large to analyze safely.");
    }

    stage = "collect_visual_evidence";
    const visualEvidence = await withDeadline(
      page.evaluate<BrowserVisualEvidence>(collectVisualEvidenceInPage, maxCaptureHeight),
      remainingTimeout(deadline, settleTimeoutMs),
    );
    const base64 = Buffer.from(screenshotBytes).toString("base64");

    return {
      isOk: true,
      html,
      finalUrl: finalGuard.url.toString(),
      screenshot: {
        mediaType: SCREENSHOT_MEDIA_TYPE,
        base64,
        dataUrl: `data:${SCREENSHOT_MEDIA_TYPE};base64,${base64}`,
        width: DEFAULT_VIEWPORT_WIDTH,
        height: dimensions.captureHeight,
        byteLength: screenshotBytes.byteLength,
      },
      visualEvidence,
      requestCount,
    };
  } catch (error) {
    if (error instanceof BrowserRenderDeadlineError || dependencies.now() >= deadlineAtMs) {
      return failure(
        "timeout",
        "That site took too long to render. Flock can continue with its standard page reader.",
      );
    }
    logRecord(
      {
        tag: "flock.brandKit.browserRenderFailed",
        stage,
        reason: error instanceof Error ? error.message : "unknown_error",
      },
      "error",
    );
    return failure("capture_failed", "Flock couldn't capture that rendered page.");
  } finally {
    if (page !== null && requestListener !== null) {
      page.off?.("request", requestListener);
    }
    if (page !== null && popupListener !== null) {
      page.off?.("popup", popupListener);
    }
    await closeQuietly(page);
    await closeQuietly(browser);
  }
}

/*
  Render a public page in a real browser and return bounded visual evidence.
  Every network request is paused until it passes the same URL/DNS guard used
  by the static scraper. Callers should treat failures as a soft signal and
  retain the existing static-fetch path as their fallback.
*/
export async function renderPageInBrowser(
  rawUrl: string,
  options: BrowserRenderOptions = {},
): Promise<BrowserRenderResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const dependencies: BrowserRenderDependencies = {
    launchBrowser: options.dependencies?.launchBrowser ?? launchDefaultBrowser,
    guardUrl: options.dependencies?.guardUrl ?? guardUrl,
    now: options.dependencies?.now ?? Date.now,
  };
  const deadlineAtMs = dependencies.now() + timeoutMs;

  try {
    return await renderWithBrowser({ rawUrl, options, dependencies, deadlineAtMs });
  } catch (error) {
    if (error instanceof BrowserRenderDeadlineError) {
      return failure(
        "timeout",
        "That site took too long to render. Flock can continue with its standard page reader.",
      );
    }
    return failure("capture_failed", "Flock couldn't capture that rendered page.");
  }
}
