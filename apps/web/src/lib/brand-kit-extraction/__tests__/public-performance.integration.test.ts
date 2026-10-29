import { collectBrandEvidence } from "../collect-brand-evidence";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { acquirePage } from "../acquire-page";
import { discardWarmBrowser, getWarmBrowser, type ManagedBrowserLike } from "../browser-manager";
import { renderPageInBrowser, type BrowserRenderOptions } from "../browser-render";
import { fetchPage } from "../fetch-page";
import { extractSiteIdentity } from "../extract-site-identity";
import { harvestBrandSignals } from "../harvest";
import { selectRepresentativeSourceImages } from "../source-image-evidence";
import { rehostSourceImages } from "../rehost-source-images";

const isEnabled = process.env.FLOCK_RUN_PERFORMANCE_BENCHMARK === "1";
const outputDirectory = process.env.FLOCK_BENCHMARK_OUTPUT;
const benchmarkLabel = process.env.FLOCK_BENCHMARK_LABEL ?? "local-chromium-unspecified";
const requestedRepetitions = Number.parseInt(process.env.FLOCK_BENCHMARK_REPETITIONS ?? "3", 10);
const repetitions = Number.isFinite(requestedRepetitions) ? Math.max(1, requestedRepetitions) : 3;
const selectedSiteIds = process.env.FLOCK_BENCHMARK_SITES?.split(",").map((siteId) => siteId.trim()).filter(Boolean);

const benchmarkSites = [
  { id: "example", url: "https://example.com/", expectedMode: "static-minimal" },
  { id: "iana-example-domains", url: "https://www.iana.org/help/example-domains", expectedMode: "static-content" },
  { id: "perc-coffee", url: "https://perccoffee.com/", expectedMode: "server-rendered-commerce" },
  { id: "calendly", url: "https://calendly.com/", expectedMode: "server-rendered-saas" },
  { id: "teeny", url: "https://www.teeny.fun/", expectedMode: "javascript-sensitive" },
  { id: "brightwheel", url: "https://mybrightwheel.com/", expectedMode: "server-rendered-saas" },
  { id: "react-shopping-cart", url: "https://react-shopping-cart-67954.firebaseapp.com/", expectedMode: "javascript-app" },
  { id: "books-product", url: "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html", expectedMode: "static-product" },
] as const;

type TimingMap = Record<string, number[]>;
const allMethodTimings: TimingMap = {};
let activeRunId = "setup";
let activeStageTimings: Record<string, number> = {};
let browserWasLaunched = false;
let browserRuntime = "unknown";
let isBrowserClosed = false;
let isColdRun = false;
let measuredRenderMs = 0;
let measuredBrowserLaunchMs = 0;
let chromeVersion = "unknown";

/*
  Wrap browser objects and time each awaited Puppeteer method. This keeps
  instrumentation in the harness and leaves production code untouched.
*/
function instrumentBrowserObject<Value extends object>(value: Value, parentStage: string): Value {
  return new Proxy(value, {
    get(target, property) {
      const member = Reflect.get(target, property) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const stage = getMethodStage({ methodName: String(property), parentStage, evaluationFunction: args[0] });
        const startedAt = performance.now();
        const result = Reflect.apply(member, target, args) as unknown;
        if (result === null || typeof result !== "object" || !("then" in result)) return result;
        return Promise.resolve(result).then((resolvedResult) => {
          recordTiming(stage, performance.now() - startedAt);
          if (resolvedResult !== null && typeof resolvedResult === "object" && isBrowserHandleMethod(String(property))) {
            return instrumentBrowserObject(resolvedResult, stage);
          }
          return resolvedResult;
        }, (error: unknown) => {
          recordTiming(stage, performance.now() - startedAt);
          throw error;
        });
      };
    },
  });
}

function isBrowserHandleMethod(methodName: string): boolean {
  return ["createBrowserContext", "newPage", "createCDPSession"].includes(methodName);
}

function getMethodStage({ methodName, parentStage, evaluationFunction }: { methodName: string; parentStage: string; evaluationFunction?: unknown }): string {
  if (methodName === "evaluate") return `${parentStage}.${getEvaluationName(evaluationFunction)}`;
  const methodStages: Record<string, string> = {
    goto: "navigation",
    waitForNetworkIdle: "network_idle",
    screenshot: "screenshot",
    content: "capture_html",
    evaluate: "evaluate",
    evaluateOnNewDocument: "setup_document",
    setViewport: "set_viewport",
    createBrowserContext: "create_context",
    newPage: "create_page",
    createCDPSession: "create_cdp_session",
    send: "cdp_send",
    close: "close_page_context",
    setRequestInterception: "request_interception",
    setBypassServiceWorker: "service_worker_bypass",
  };
  return methodStages[methodName] ?? `${parentStage}.${methodName}`;
}

function getEvaluationName(evaluationFunction: unknown): string {
  if (typeof evaluationFunction !== "function") return "evaluate_anonymous";
  return evaluationFunction.name || "evaluate_anonymous";
}

function recordTiming(stage: string, durationMs: number): void {
  activeStageTimings[stage] = (activeStageTimings[stage] ?? 0) + durationMs;
  const allKey = `${activeRunId}.${stage}`;
  allMethodTimings[allKey] ??= [];
  allMethodTimings[allKey].push(durationMs);
}

async function launchMeasuredBrowser(): Promise<ManagedBrowserLike> {
  const chromePath = process.env.CHROME_EXECUTABLE_PATH;
  if (chromePath === undefined || chromePath.length === 0) throw new Error("Set CHROME_EXECUTABLE_PATH to label this as an explicit local Chrome measurement.");
  const executablePath = chromePath;
  const args = ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"];
  browserRuntime = `local-chrome:${path.basename(chromePath)}`;
  const launchStartedAt = performance.now();
  const launchedBrowser = await puppeteer.launch({
    executablePath,
    headless: true,
    args,
  });
  measuredBrowserLaunchMs = performance.now() - launchStartedAt;
  chromeVersion = await launchedBrowser.version();
  recordTiming("browser_launch", measuredBrowserLaunchMs);
  browserWasLaunched = true;
  isBrowserClosed = false;
  isColdRun = true;
  return launchedBrowser as unknown as ManagedBrowserLike;
}

async function renderWithMeasuredBrowser(rawUrl: string) {
  const startedAt = performance.now();
  const result = await renderPageInBrowser(rawUrl, {
    dependencies: {
      launchBrowser: async () => {
        const browser = await getWarmBrowser(launchMeasuredBrowser);
        return instrumentBrowserObject(browser, "browser");
      },
    } as BrowserRenderOptions["dependencies"],
  });
  measuredRenderMs = performance.now() - startedAt;
  return result;
}

async function closeCurrentBrowser(): Promise<void> {
  if (!browserWasLaunched || isBrowserClosed) return;
  try {
    const browser = await getWarmBrowser(async () => { throw new Error("No retained browser process."); });
    await discardWarmBrowser(browser);
    isBrowserClosed = true;
  } catch {
    isBrowserClosed = true;
  }
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runSite({ site, repetition, outputPath }: { site: (typeof benchmarkSites)[number]; repetition: number; outputPath: string }) {
  activeRunId = `${site.id}-r${repetition}`;
  activeStageTimings = {};
  measuredRenderMs = 0;
  measuredBrowserLaunchMs = 0;
  const runStartedAt = performance.now();
  let fetchMs = 0;
  const acquireStartedAt = performance.now();
  const acquireResult = await acquirePage(site.url, {
    dependencies: {
      fetchPage: async (url) => {
        const fetchStartedAt = performance.now();
        const result = await fetchPage(url);
        fetchMs = performance.now() - fetchStartedAt;
        return result;
      },
      renderPage: renderWithMeasuredBrowser,
    },
  });
  const acquirePageWallMs = performance.now() - acquireStartedAt;
  const http = acquireResult.outcomes.http;
  const browserResult = acquireResult.outcomes.browser;
  const browserMs = measuredRenderMs;
  const renderedHtml = browserResult?.isOk === true ? browserResult.html : "";
  const effectiveHtml = browserResult?.isOk === true
    ? `${renderedHtml}\n<style data-flock-synthetic-evidence>${browserResult.visualEvidence.syntheticCss}</style>`
    : http.isOk ? http.html : renderedHtml;
  const finalUrl = browserResult?.isOk === true ? browserResult.finalUrl : http.finalUrl ?? site.url;

  let harvestMs = 0;
  let sourceSelectionMs = 0;
  const { signals: harvested, sourceImages } = await collectBrandEvidence({
    html: effectiveHtml, finalUrl,
    renderedColors: browserResult?.isOk === true ? browserResult.visualEvidence.colors : [],
  }, { dependencies: {
    harvestSignals: async (input) => {
      const startedAt = performance.now();
      try { return await harvestBrandSignals(input); }
      finally { harvestMs = performance.now() - startedAt; }
    },
    selectImages: async (input) => {
      const startedAt = performance.now();
      try { return await selectRepresentativeSourceImages(input); }
      finally { sourceSelectionMs = performance.now() - startedAt; }
    },
  } });
  const identityStartedAt = performance.now();
  const identity = effectiveHtml.length > 0 ? extractSiteIdentity({ html: effectiveHtml, baseUrl: finalUrl }) : null;
  const identityMs = performance.now() - identityStartedAt;
  const rehostStartedAt = performance.now();
  const rehostedImages = await rehostSourceImages({
    sourceImages,
    rehost: async ({ sourceImage }) => sourceImage.url,
  });
  const imageDownloadMs = performance.now() - rehostStartedAt;

  const screenshot = browserResult?.isOk === true ? Buffer.from(browserResult.screenshot.base64, "base64") : null;
  const screenshotName = screenshot === null ? null : `${site.id}-r${repetition}.jpg`;
  if (screenshot !== null && screenshotName !== null) await writeFile(path.join(outputPath, screenshotName), screenshot);
  const report = {
    schemaVersion: 1,
    evidenceScheduling: "parallel-css-and-image-verification",
    benchmarkLabel,
    browserRuntime,
    chromeVersion,
    sourceRevision: process.env.FLOCK_BENCHMARK_GIT_SHA ?? null,
    site: { id: site.id, url: site.url, expectedMode: site.expectedMode },
    repetition,
    isColdBrowserLaunch: isColdRun,
    elapsedMs: round(performance.now() - runStartedAt),
    acquirePageWallMs: round(acquirePageWallMs),
    http: {
      elapsedMs: round(fetchMs),
      isOk: http.isOk,
      status: http.status ?? null,
      reason: http.isOk ? null : http.reason,
      finalUrl: http.finalUrl ?? null,
      htmlBytes: http.isOk ? Buffer.byteLength(http.html) : 0,
      htmlSha256: http.isOk ? sha256(http.html) : null,
    },
    browser: {
      elapsedMs: round(browserMs),
      launchMs: round(measuredBrowserLaunchMs),
      isOk: browserResult?.isOk ?? false,
      reason: browserResult?.isOk === false ? browserResult.reason : null,
      finalUrl: browserResult?.isOk === true ? browserResult.finalUrl : null,
      htmlBytes: Buffer.byteLength(renderedHtml),
      htmlSha256: renderedHtml.length > 0 ? sha256(renderedHtml) : null,
      screenshot: browserResult?.isOk === true ? {
        file: screenshotName,
        sha256: screenshot === null ? null : sha256(screenshot),
        mediaType: browserResult.screenshot.mediaType,
        width: browserResult.screenshot.width,
        height: browserResult.screenshot.height,
        byteLength: browserResult.screenshot.byteLength,
      } : null,
      requestCount: browserResult?.isOk === true ? browserResult.requestCount : null,
      semantic: browserResult?.isOk === true ? {
        isUsable: browserResult.semanticEvidence?.isUsable ?? false,
        headings: browserResult.semanticEvidence?.headings ?? [],
        paragraphCount: browserResult.semanticEvidence?.firstParagraph === null ? 0 : browserResult.semanticEvidence?.firstParagraph === undefined ? 0 : 1,
        firstParagraph: browserResult.semanticEvidence?.firstParagraph ?? null,
        ctaLabels: browserResult.semanticEvidence?.ctaLabels ?? [],
      } : null,
      visual: browserResult?.isOk === true ? {
        colors: browserResult.visualEvidence.colors,
        fonts: browserResult.visualEvidence.fonts,
        elements: browserResult.visualEvidence.elements,
        viewport: browserResult.visualEvidence.viewport,
        document: browserResult.visualEvidence.document,
      } : null,
      methodTimingsMs: Object.fromEntries(Object.entries(activeStageTimings).map(([key, value]) => [key, round(value)])),
    },
    extraction: {
      harvestMs: round(harvestMs),
      identityMs: round(identityMs),
      sourceSelectionMs: round(sourceSelectionMs),
      imageDownloadMs: round(imageDownloadMs),
      verifiedDownloadedImageCount: rehostedImages.length,
      identity,
      themeColor: harvested?.themeColor ?? null,
      fontFamilies: harvested?.fontFamilies ?? [],
      rankedColors: harvested?.rankedColors ?? [],
      accentCandidates: harvested?.accentCandidates ?? [],
      logoCandidates: harvested?.logoCandidates ?? [],
      sourceImageUrls: sourceImages.map((image) => image.url),
    },
    renderedExtraction: {
      isUsingRenderedHtml: browserResult?.isOk === true,
      staticIdentity: http.isOk ? extractSiteIdentity({ html: http.html, baseUrl: http.finalUrl }) : null,
      renderedIdentity: renderedHtml.length > 0 ? extractSiteIdentity({ html: renderedHtml, baseUrl: finalUrl }) : null,
    },
    notes: ["Explicit local Chromium measurement; not Vercel runtime performance.", "Image URL verification and guarded image downloads are measured; storage upload is stubbed by returning source URL and excluded."],
  };
  await appendJsonLine(path.join(outputPath, "runs.jsonl"), report);
  await writeFile(path.join(outputPath, `${site.id}-r${repetition}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

type RunReport = Awaited<ReturnType<typeof runSite>>;
type RunFailure = {
  schemaVersion: number;
  benchmarkLabel: string;
  site: (typeof benchmarkSites)[number];
  repetition: number;
  isOk: false;
  failure: { name: string; message: string };
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((left, right) => left - right);
  return round(sortedValues[Math.min(sortedValues.length - 1, Math.ceil(fraction * sortedValues.length) - 1)]);
}

async function writeAggregate(outputPath: string, reports: Array<RunReport | RunFailure>): Promise<void> {
  const sitesToAggregate = selectedSiteIds === undefined ? benchmarkSites : benchmarkSites.filter((site) => selectedSiteIds.includes(site.id));
  const aggregates = sitesToAggregate.map((site) => {
    const siteReports = reports.filter((report) => report.site.id === site.id);
    const goodReports = siteReports.filter((report): report is RunReport => "browser" in report);
    const totalTimes = goodReports.map((report) => report.elapsedMs);
    const browserTimes = goodReports.map((report) => report.browser.elapsedMs);
    const successful = goodReports.filter((report) => report.browser.isOk === true);
    return {
      site,
      runCount: siteReports.length,
      browserSuccessCount: successful.length,
      runFailures: siteReports.filter((report): report is RunFailure => "failure" in report).map((report) => report.failure),
      browserFailureClasses: goodReports.filter((report) => report.browser.isOk !== true).map((report) => report.browser.reason),
      acquisitionMedianMs: percentile(totalTimes, 0.5),
      acquisitionP95Ms: percentile(totalTimes, 0.95),
      browserMedianMs: percentile(browserTimes, 0.5),
      browserP95Ms: percentile(browserTimes, 0.95),
      screenshotSuccessCount: successful.filter((report) => report.browser.screenshot !== null).length,
      semanticUsableCount: successful.filter((report) => report.browser.semantic?.isUsable === true).length,
      coldLaunchMedianMs: percentile(goodReports.filter((report) => report.isColdBrowserLaunch).map((report) => report.browser.elapsedMs), 0.5),
      warmMedianMs: percentile(goodReports.filter((report) => !report.isColdBrowserLaunch).map((report) => report.browser.elapsedMs), 0.5),
    };
  });
  const aggregate = { schemaVersion: 1, benchmarkLabel, browserRuntime, chromeVersion, sourceRevision: process.env.FLOCK_BENCHMARK_GIT_SHA ?? null, repetitionsPerSite: repetitions, generatedAt: new Date().toISOString(), sites: aggregates, methodTimingMs: allMethodTimings };
  await writeFile(path.join(outputPath, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
}

afterAll(async () => {
  await closeCurrentBrowser();
});

describe.skipIf(!isEnabled || outputDirectory === undefined)("public scraping performance benchmark", () => {
  it("records cold and warm local Chromium capture and deterministic extraction for the fixed site set", async () => {
    if (outputDirectory === undefined || !path.isAbsolute(outputDirectory)) throw new Error("FLOCK_BENCHMARK_OUTPUT must be an absolute directory path.");
    await mkdir(outputDirectory, { recursive: true });
    /* Keep recorded baselines immutable: reruns require a new output directory. */
    await writeFile(path.join(outputDirectory, "runs.jsonl"), "", { flag: "wx" });
    const reports: Array<RunReport | RunFailure> = [];
    const sitesToRun = selectedSiteIds === undefined ? benchmarkSites : benchmarkSites.filter((site) => selectedSiteIds.includes(site.id));
    const runOrder = sitesToRun.flatMap((site) => Array.from({ length: repetitions }, (_unused, index) => ({ site, repetition: index + 1 })));
    for (const { site, repetition } of runOrder) {
      try {
        if (repetition === 1) await closeCurrentBrowser();
        isColdRun = repetition === 1;
        const report = await runSite({ site, repetition, outputPath: outputDirectory });
        reports.push(report);
      } catch (error) {
        const failure: RunFailure = {
          schemaVersion: 1,
          benchmarkLabel,
          site,
          repetition,
          isOk: false,
          failure: error instanceof Error ? { name: error.name, message: error.message.slice(0, 240) } : { name: "unknown", message: "unknown_error" },
        };
        await appendJsonLine(path.join(outputDirectory, "runs.jsonl"), failure);
        await writeFile(path.join(outputDirectory, `${site.id}-r${repetition}-failure.json`), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
        reports.push(failure);
      }
    }
    await writeAggregate(outputDirectory, reports);
    expect(reports.filter((report): report is RunFailure => "failure" in report)).toEqual([]);
    expect(reports).toHaveLength(sitesToRun.length * repetitions);
  }, 900_000);
});
