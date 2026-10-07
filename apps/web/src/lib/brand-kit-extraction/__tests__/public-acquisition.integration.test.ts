import { afterAll, describe, expect, it } from "vitest";
import { discardWarmBrowser, getWarmBrowser } from "../browser-manager";
import { acquirePage } from "../acquire-page";

const isEnabled = process.env.FLOCK_RUN_PUBLIC_SCRAPING_TESTS === "1";
const benchmarkUrls = [
  "https://calendly.com/",
  "https://perccoffee.com/",
  "https://www.teeny.fun/",
  "https://mybrightwheel.com/",
];

describe.skipIf(!isEnabled)("public site acquisition benchmark", () => {
  afterAll(async () => {
    try {
      const browser = await getWarmBrowser(async () => { throw new Error("No warm Chromium process was retained."); });
      await discardWarmBrowser(browser);
    } catch {
      /* A failed acquisition can leave no warm browser to close. */
    }
  });

  it("records public acquisition evidence without asserting third-party availability", async () => {
    for (const rootPageUrl of benchmarkUrls) {
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof acquirePage>>;
      try {
        result = await acquirePage(rootPageUrl);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({
          rootPageUrl,
          elapsedMs: Date.now() - startedAt,
          thrownClass: error instanceof Error ? error.name : "unknown",
          thrownMessage: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
        })}\n`);
        continue;
      }

      const renderedPage = result.isOk ? result.renderedPage : result.outcomes.browser?.isOk ? result.outcomes.browser : null;
      const report = {
        rootPageUrl,
        finalUrl: result.finalUrl ?? result.outcomes.http.finalUrl ?? null,
        elapsedMs: Date.now() - startedAt,
        isOk: result.isOk,
        httpClass: result.outcomes.http.isOk ? "success" : result.outcomes.http.reason,
        httpStatus: result.outcomes.http.status ?? null,
        browserClass: result.outcomes.browser === null ? "not_attempted" : result.outcomes.browser.isOk ? "success" : result.outcomes.browser.reason,
        recoveryClass: result.outcomes.recovery === null ? "not_attempted" : result.outcomes.recovery.isOk ? "success" : result.outcomes.recovery.reason,
        hasNonemptyHtml: result.isOk && result.html.trim().length > 0,
        hasValidFinalUrl: result.isOk && isValidFinalUrl(result.finalUrl),
        hasUsableSemanticEvidence: renderedPage?.isOk === true && renderedPage.semanticEvidence?.isUsable === true,
        headings: renderedPage?.isOk === true ? (renderedPage.semanticEvidence?.headings ?? []).map(({ level, text }) => ({ level, text })) : [],
        renderedColorCount: renderedPage?.isOk === true ? renderedPage.visualEvidence.colors.length : 0,
      };
      process.stdout.write(`${JSON.stringify(report)}\n`);

      if (result.isOk) {
        expect(report.hasNonemptyHtml).toBe(true);
        expect(report.hasValidFinalUrl).toBe(true);
      }
    }
  }, 240_000);
});

function isValidFinalUrl(rawUrl: string): boolean {
  try {
    const parsedUrl = new URL(rawUrl);
    return (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") && parsedUrl.hostname.includes(".");
  } catch {
    return false;
  }
}
