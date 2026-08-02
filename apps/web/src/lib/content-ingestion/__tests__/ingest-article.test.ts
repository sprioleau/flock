import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestArticle } from "../ingest-article";

/**
 * The §7.4 pipeline ordering and — above all — the ONE rule that matters
 * most: a page that could not be read produces a refusal with a user-facing
 * message and NOTHING resembling content. These tests pin each way a fetch can
 * be prevented (robots.txt, a site block, a paywall) to a refusal, and pin the
 * hero-image path to "store it or drop it", never a hot-link.
 */

vi.mock("../robots", () => ({ isFetchAllowedByRobots: vi.fn() }));
vi.mock("../../brand-kit-extraction/fetch-page", () => ({ fetchPage: vi.fn() }));
vi.mock("../rehost-image", () => ({ rehostImageToStorage: vi.fn() }));

const { isFetchAllowedByRobots } = await import("../robots");
const { fetchPage } = await import("../../brand-kit-extraction/fetch-page");
const { rehostImageToStorage } = await import("../rehost-image");

const mockIsFetchAllowedByRobots = vi.mocked(isFetchAllowedByRobots);
const mockFetchPage = vi.mocked(fetchPage);
const mockRehostImageToStorage = vi.mocked(rehostImageToStorage);

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const ARTICLE_HTML = readFileSync(path.join(fixturesDir, "article-page.html"), "utf-8");
const PAYWALL_HTML = readFileSync(path.join(fixturesDir, "paywall-stub.html"), "utf-8");
const ARTICLE_URL = "https://www.dailymeridian.com/climate/solar-canopy-city";

afterEach(() => {
  vi.resetAllMocks();
});

function allowRobots(): void {
  mockIsFetchAllowedByRobots.mockResolvedValue(true);
}

function serveHtml(html: string, finalUrl = ARTICLE_URL): void {
  mockFetchPage.mockResolvedValue({ isOk: true, html, finalUrl });
}

describe("ingestArticle — the fetch is prevented", () => {
  it("stops at robots.txt WITHOUT fetching the page, and says so", async () => {
    mockIsFetchAllowedByRobots.mockResolvedValue(false);

    const result = await ingestArticle({ url: ARTICLE_URL });

    expect(mockFetchPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_robots" });
    if (result.isOk) return;
    expect(result.message).toContain("robots.txt");
    // The refusal is a plain sentence a person can act on — no content in it.
    expect(result.message).toContain("Nothing was made up in its place");
  });

  it("relays a site block in article terms and invents nothing", async () => {
    allowRobots();
    mockFetchPage.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_site",
      message: "…brand-kit-flavored copy…",
    });

    const result = await ingestArticle({ url: ARTICLE_URL });

    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_site" });
    if (result.isOk) return;
    expect(result.message).toContain("blocks automated access");
    expect(result.message).not.toContain("branding");
  });

  it("passes other fetch failures through with their own machine reason", async () => {
    allowRobots();
    mockFetchPage.mockResolvedValue({
      isOk: false,
      reason: "timeout",
      message: "That site took too long to respond. Please try again in a moment.",
    });

    const result = await ingestArticle({ url: ARTICLE_URL });

    expect(result).toMatchObject({ isOk: false, reason: "timeout" });
  });

  it("refuses a paywalled page rather than dressing up the teaser", async () => {
    allowRobots();
    serveHtml(PAYWALL_HTML, "https://harborbusinessjournal.com/ports/merger-talks");

    const result = await ingestArticle({ url: "https://harborbusinessjournal.com/ports/merger-talks" });

    expect(result).toMatchObject({ isOk: false, reason: "paywalled" });
    expect(mockRehostImageToStorage).not.toHaveBeenCalled();
  });
});

describe("ingestArticle — a readable article", () => {
  it("returns the page's ACTUAL content with its attribution fields", async () => {
    allowRobots();
    serveHtml(ARTICLE_HTML);
    mockRehostImageToStorage.mockResolvedValue("https://storage.convex.cloud/stored-hero.jpg");

    const result = await ingestArticle({ url: ARTICLE_URL, sessionId: "session_1" });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.article.title).toBe("City to build solar canopy over downtown parking");
    expect(result.article.canonicalUrl).toBe(ARTICLE_URL);
    expect(result.article.sourceName).toBe("The Daily Meridian");
    expect(result.article.mainText).toContain("voted 8-1 on Tuesday");
  });

  it("serves the hero image from OUR storage, filed under the caller's session", async () => {
    allowRobots();
    serveHtml(ARTICLE_HTML);
    mockRehostImageToStorage.mockResolvedValue("https://storage.convex.cloud/stored-hero.jpg");

    const result = await ingestArticle({ url: ARTICLE_URL, sessionId: "session_1" });

    if (!result.isOk) throw new Error("expected success");
    expect(result.article.heroImageUrl).toBe("https://storage.convex.cloud/stored-hero.jpg");
    expect(mockRehostImageToStorage).toHaveBeenCalledWith({
      imageUrl: "https://www.dailymeridian.com/images/solar-canopy-hero.jpg",
      sessionId: "session_1",
      name: "City to build solar canopy over downtown parking",
      sourceUrl: ARTICLE_URL,
    });
  });

  it("DROPS a hero image it could not store — never hot-links the origin", async () => {
    allowRobots();
    serveHtml(ARTICLE_HTML);
    mockRehostImageToStorage.mockResolvedValue(null);

    const result = await ingestArticle({ url: ARTICLE_URL });

    if (!result.isOk) throw new Error("expected success");
    expect(result.article.heroImageUrl).toBeUndefined();
    // The rest of the article survives — the image was a nicety, the text is not.
    expect(result.article.mainText).toContain("voted 8-1 on Tuesday");
  });

  it("skips rehosting entirely when the caller opts out", async () => {
    allowRobots();
    serveHtml(ARTICLE_HTML);

    const result = await ingestArticle({ url: ARTICLE_URL, shouldRehostHeroImage: false });

    if (!result.isOk) throw new Error("expected success");
    expect(result.article.heroImageUrl).toBeUndefined();
    expect(mockRehostImageToStorage).not.toHaveBeenCalled();
  });
});
