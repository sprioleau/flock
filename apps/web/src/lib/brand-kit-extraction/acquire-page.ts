import { logRecord } from "../observability/log";
import { recoverBrandAssets, type AssetRecoveryResult } from "./asset-recovery";
import { renderPageInBrowser, type BrowserRenderResult, type BrowserRenderSuccess } from "./browser-render";
import { fetchPage, type FetchPageFailure, type FetchPageResult } from "./fetch-page";
import { validateUrlSyntax, type UrlGuardResult } from "./url-guard";

export interface PageAcquisitionOutcomes {
  http: FetchPageResult;
  browser: BrowserRenderResult | null;
  recovery: AssetRecoveryResult | null;
}

export interface PageAcquisitionSuccess {
  isOk: true;
  html: string;
  finalUrl: string;
  renderedPage: BrowserRenderSuccess | null;
  outcomes: PageAcquisitionOutcomes;
}

export type PageAcquisitionFailure = FetchPageFailure & { outcomes: PageAcquisitionOutcomes };
export type PageAcquisitionResult = PageAcquisitionSuccess | PageAcquisitionFailure;

export interface AcquirePageDependencies {
  validateUrl(url: string): UrlGuardResult;
  fetchPage(url: string): Promise<FetchPageResult>;
  renderPage(url: string): Promise<BrowserRenderResult>;
  recoverAssets(url: string): Promise<AssetRecoveryResult>;
}

const RECOVERABLE_FAILURES = new Set(["timeout", "http_error", "blocked_by_site", "blocked_by_bot_challenge", "network"]);
const CHALLENGE_MARKERS = /<title>\s*(just a moment|attention required|verify you are human|security check)[^<]*<\/title>|checking your browser before accessing|<body[^>]*>\s*(?:<[^>]+>\s*)*(access denied|request blocked|security verification required)/i;

function isChallengeHtml(html: string): boolean {
  return CHALLENGE_MARKERS.test(html.slice(0, 100_000));
}

function logOutcome({
  http,
  browser,
  recovery,
}: PageAcquisitionOutcomes): void {
  const hasBrowserSuccessAfterFailure = !http.isOk && browser?.isOk === true && !isChallengeHtml(browser.html);
  const isRecovered = !http.isOk && recovery?.isOk === true;
  logRecord({
    tag: "flock.brandKit.pageAcquisitionOutcome",
    httpClass: http.isOk ? "success" : http.reason,
    httpStatus: http.status,
    httpFinalUrl: http.finalUrl,
    browserClass: browser === null ? "not_attempted" : browser.isOk ? isChallengeHtml(browser.html) ? "challenge" : "success" : browser.reason,
    recoveryClass: recovery === null ? "not_attempted" : recovery.isOk ? "success" : recovery.reason,
    browserSuccessAfterHttpFailure: hasBrowserSuccessAfterFailure,
  }, http.isOk || hasBrowserSuccessAfterFailure || isRecovered ? "info" : "error");
}

export async function acquirePage(
  rawUrl: string,
  options: { dependencies?: Partial<AcquirePageDependencies> } = {},
): Promise<PageAcquisitionResult> {
  const deps: AcquirePageDependencies = {
    validateUrl: validateUrlSyntax,
    fetchPage,
    renderPage: renderPageInBrowser,
    recoverAssets: recoverBrandAssets,
    ...options.dependencies,
  };
  const invalid = deps.validateUrl(rawUrl);
  if (!invalid.isAllowed) {
    const http: FetchPageFailure = {
      isOk: false,
      reason: "invalid_url",
      message: "We can only read public http and https websites.",
    };
    const outcomes: PageAcquisitionOutcomes = { http, browser: null, recovery: null };
    logOutcome(outcomes);
    return { ...http, outcomes };
  }
  let http = await deps.fetchPage(rawUrl);
  if (http.isOk && isChallengeHtml(http.html)) {
    http = {
      isOk: false,
      reason: "blocked_by_bot_challenge",
      message: "This site returned a browser challenge, so its branding cannot be read automatically.",
      status: http.status,
      finalUrl: http.finalUrl,
    };
  }
  const outcomes: PageAcquisitionOutcomes = { http, browser: null, recovery: null };
  if (http.isOk) {
    let browser: BrowserRenderResult;
    try {
      browser = await deps.renderPage(http.finalUrl);
    } catch {
      browser = { isOk: false, reason: "capture_failed", message: "Browser rendering failed." };
    }
    outcomes.browser = browser;
    const renderedPage = browser.isOk && !isChallengeHtml(browser.html) ? browser : null;
    const result = { isOk: true as const, html: http.html, finalUrl: http.finalUrl, renderedPage, outcomes };
    logOutcome(outcomes);
    return result;
  }

  if (!RECOVERABLE_FAILURES.has(http.reason)) {
    logOutcome(outcomes);
    return { ...http, outcomes };
  }

  let browser: BrowserRenderResult;
  try {
    browser = await deps.renderPage(rawUrl);
  } catch {
    browser = { isOk: false, reason: "capture_failed", message: "Browser rendering failed." };
  }
  outcomes.browser = browser;
  if (browser.isOk && !isChallengeHtml(browser.html)) {
    const result = { isOk: true as const, html: browser.html, finalUrl: browser.finalUrl, renderedPage: browser, outcomes };
    logOutcome(outcomes);
    return result;
  }

  if (!browser.isOk && ["invalid_url", "blocked_host", "dns"].includes(browser.reason)) {
    logOutcome(outcomes);
    return { ...http, outcomes };
  }

  let recovery: AssetRecoveryResult;
  try {
    recovery = await deps.recoverAssets(rawUrl);
  } catch {
    recovery = { isOk: false, reason: "asset_recovery_failed" };
  }
  outcomes.recovery = recovery;
  if (recovery.isOk) {
    const result = { isOk: true as const, html: recovery.html, finalUrl: recovery.finalUrl, renderedPage: null, outcomes };
    logOutcome(outcomes);
    return result;
  }
  logOutcome(outcomes);
  return { ...http, outcomes };
}
