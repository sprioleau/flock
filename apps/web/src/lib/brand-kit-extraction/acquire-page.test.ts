import { describe, expect, it, vi } from "vitest";
import { acquirePage, type AcquirePageDependencies } from "./acquire-page";
import type { BrowserRenderResult } from "./browser-render";
import type { FetchPageResult } from "./fetch-page";
import type { AssetRecoveryResult } from "./asset-recovery";
import { validateUrlSyntax } from "./url-guard";

const URL = "https://public.example/";
const httpSuccess: FetchPageResult = { isOk: true, html: "<html>http</html>", finalUrl: URL };
const browserSuccess: BrowserRenderResult = {
  isOk: true,
  html: "<html>rendered app</html>",
  finalUrl: URL,
  screenshot: { mediaType: "image/jpeg", base64: "AA==", dataUrl: "data:image/jpeg;base64,AA==", width: 1, height: 1, byteLength: 1 },
  visualEvidence: { viewport: { width: 1, height: 1 }, document: { width: 1, height: 1 }, colors: [], fonts: [], elements: [], syntheticCss: "" },
  requestCount: 1,
};
const recoverySuccess: AssetRecoveryResult = { isOk: true, html: "<html>evidence</html>", finalUrl: URL, siteName: "Example", themeColor: "#123456", iconUrl: `${URL}icon.png` };
const readFailure: FetchPageResult = { isOk: false, reason: "http_error", message: "Read failed." };

function dependencies(overrides: Partial<AcquirePageDependencies> = {}): AcquirePageDependencies {
  return {
    validateUrl: validateUrlSyntax,
    fetchPage: vi.fn(async () => httpSuccess),
    renderPage: vi.fn(async () => browserSuccess),
    recoverAssets: vi.fn(async () => ({ isOk: false as const, reason: "no_verified_icon" })),
    ...overrides,
  };
}

describe("acquirePage", () => {
  it("does not launch browser or recovery for an invalid/private URL", async () => {
    const deps = dependencies();
    const result = await acquirePage("http://127.0.0.1/", { dependencies: deps });
    expect(result).toMatchObject({ isOk: false, reason: "invalid_url" });
    expect(deps.fetchPage).not.toHaveBeenCalled();
    expect(deps.renderPage).not.toHaveBeenCalled();
    expect(deps.recoverAssets).not.toHaveBeenCalled();
  });

  it("keeps HTTP source when Chromium fails after a successful HTTP read", async () => {
    const deps = dependencies({ renderPage: vi.fn(async (): Promise<BrowserRenderResult> => ({ isOk: false, reason: "browser_unavailable", message: "Unavailable" })) });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: true, html: "<html>http</html>", renderedPage: null });
    expect(deps.recoverAssets).not.toHaveBeenCalled();
  });

  it("keeps HTTP source when the renderer throws unexpectedly", async () => {
    const deps = dependencies({ renderPage: vi.fn(async () => { throw new Error("renderer crashed"); }) });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: true, html: "<html>http</html>", renderedPage: null });
  });

  it("does not classify a normal page with a CAPTCHA integration as a challenge", async () => {
    const normalPage = { ...browserSuccess, html: "<html><head><script src=\"captcha.js\"></script></head><body>Welcome</body></html>" };
    const deps = dependencies({ fetchPage: vi.fn(async () => readFailure), renderPage: vi.fn(async () => normalPage) });
    expect(await acquirePage(URL, { dependencies: deps })).toMatchObject({ isOk: true, renderedPage: normalPage });
  });

  it("recovers a public read failure when Chromium independently reads the page", async () => {
    const deps = dependencies({ fetchPage: vi.fn(async () => readFailure) });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: true, html: "<html>rendered app</html>", renderedPage: browserSuccess });
    expect(deps.recoverAssets).not.toHaveBeenCalled();
  });

  it("does not treat a challenge document returned with HTTP success as readable content", async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async () => ({ isOk: true as const, html: "<html><title>Just a moment...</title></html>", finalUrl: URL, status: 200 })),
      renderPage: vi.fn(async (): Promise<BrowserRenderResult> => ({ isOk: false, reason: "navigation_failed", message: "Still blocked" })),
    });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_bot_challenge", status: 200 });
  });

  it("does not turn a browser challenge into success or harvest it as assets", async () => {
    const challenge: BrowserRenderResult = { ...browserSuccess, html: "<html><title>Just a moment...</title>challenge-platform</html>" };
    const deps = dependencies({ fetchPage: vi.fn(async () => readFailure), renderPage: vi.fn(async () => challenge) });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: false, reason: "http_error" });
    expect(deps.recoverAssets).toHaveBeenCalledOnce();
  });

  it("uses only the guarded asset recovery success as a final fallback", async () => {
    const deps = dependencies({ fetchPage: vi.fn(async (): Promise<FetchPageResult> => readFailure), renderPage: vi.fn(async (): Promise<BrowserRenderResult> => ({ isOk: false, reason: "navigation_failed", message: "No page" })), recoverAssets: vi.fn(async (): Promise<AssetRecoveryResult> => recoverySuccess) });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: true, html: "<html>evidence</html>", renderedPage: null, outcomes: { recovery: recoverySuccess } });
  });

  it("does not attempt Chromium or recovery after an SSRF guard failure", async () => {
    const deps = dependencies({ fetchPage: vi.fn(async (): Promise<FetchPageResult> => ({ isOk: false, reason: "blocked_host", message: "Blocked" })) });
    const result = await acquirePage(URL, { dependencies: deps });
    expect(result).toMatchObject({ isOk: false, reason: "blocked_host" });
    expect(deps.renderPage).not.toHaveBeenCalled();
    expect(deps.recoverAssets).not.toHaveBeenCalled();
  });

  it("does not recover assets after Chromium reports a guarded redirect failure", async () => {
    const deps = dependencies({ fetchPage: vi.fn(async (): Promise<FetchPageResult> => readFailure), renderPage: vi.fn(async (): Promise<BrowserRenderResult> => ({ isOk: false, reason: "blocked_host", message: "Blocked redirect" })) });
    await acquirePage(URL, { dependencies: deps });
    expect(deps.recoverAssets).not.toHaveBeenCalled();
  });
});
