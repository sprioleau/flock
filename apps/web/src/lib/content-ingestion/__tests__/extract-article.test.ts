import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractArticle,
  MAX_MAIN_TEXT_CHARS,
  TRUNCATION_MARKER,
} from "../extract-article";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

const ARTICLE_URL = "https://www.dailymeridian.com/climate/solar-canopy-city?utm_source=x";

describe("extractArticle — a real article page", () => {
  const result = extractArticle({ html: loadFixture("article-page.html"), finalUrl: ARTICLE_URL });

  it("succeeds with high confidence and full metadata", () => {
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const { article } = result;
    expect(article.title).toBe("City to build solar canopy over downtown parking");
    expect(article.byline).toBe("Dana Reeve");
    expect(article.publishedAt).toBe("2026-07-18T09:30:00Z");
    expect(article.sourceName).toBe("The Daily Meridian");
    expect(article.confidence).toBe("high");
    expect(article.isTruncated).toBe(false);
    expect(article.excerpt).toContain("4.2-megawatt solar canopy");
  });

  it("absolutizes the canonical and hero image URLs against the final URL", () => {
    if (!result.isOk) throw new Error("expected success");
    expect(result.article.canonicalUrl).toBe(
      "https://www.dailymeridian.com/climate/solar-canopy-city",
    );
    expect(result.article.heroImageUrl).toBe(
      "https://www.dailymeridian.com/images/solar-canopy-hero.jpg",
    );
  });

  it("keeps the ACTUAL article prose, including subheadings and quotes", () => {
    if (!result.isOk) throw new Error("expected success");
    const { mainText } = result.article;
    expect(mainText).toContain("voted 8-1 on Tuesday");
    expect(mainText).toContain("largest municipal solar installation in the state");
    expect(mainText).toContain("How the project will be paid for");
    expect(mainText).toContain("hottest, emptiest asphalt into shade and power");
    expect(mainText).toContain("structural study confirming the 1970s-era garage");
  });

  it("keeps ads, menus, promos, related links, comments, and footer OUT of mainText", () => {
    if (!result.isOk) throw new Error("expected success");
    const { mainText } = result.article;
    expect(mainText).not.toContain("ADVERTISEMENT");
    expect(mainText).not.toContain("GlowWidget");
    expect(mainText).not.toContain("Politics"); // nav menu
    expect(mainText).not.toContain("newsletter");
    expect(mainText).not.toContain("Share on");
    expect(mainText).not.toContain("Related stories");
    expect(mainText).not.toContain("heat plan"); // related-links text
    expect(mainText).not.toContain("First! Great article"); // comments
    expect(mainText).not.toContain("All rights reserved");
    expect(mainText).not.toContain("Sponsored placement"); // figcaption
  });
});

describe("extractArticle — honest refusals", () => {
  it("refuses a nav-heavy index page with no article prose", () => {
    const result = extractArticle({
      html: loadFixture("nav-heavy-page.html"),
      finalUrl: "https://www.dailymeridian.com/",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
    if (result.isOk) return;
    expect(result.message).toContain("wasn't enough readable content");
  });

  it("refuses a paywall stub instead of dressing up the teaser", () => {
    const result = extractArticle({
      html: loadFixture("paywall-stub.html"),
      finalUrl: "https://harborbusinessjournal.com/ports/merger-talks",
    });
    expect(result).toMatchObject({ isOk: false, reason: "paywalled" });
    if (result.isOk) return;
    expect(result.message).toContain("paywall or sign-in");
  });

  it("refuses an empty-ish page", () => {
    const result = extractArticle({
      html: "<html><body><p>Hello.</p></body></html>",
      finalUrl: "https://example.com/",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
  });
});

describe("extractArticle — caps and edge cases", () => {
  it("caps mainText at the budget with a visible truncation marker", () => {
    const paragraphs = Array.from(
      { length: 80 },
      (_, index) =>
        `<p>Paragraph ${index + 1}: the committee heard nearly two hours of testimony about the proposal, and staff promised a revised draft with updated cost figures before the next session.</p>`,
    ).join("\n");
    const html = `<html><head><title>Long story</title><meta property="og:title" content="Long story"></head><body><article>${paragraphs}</article></body></html>`;
    const result = extractArticle({ html, finalUrl: "https://example.com/long-story" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.article.isTruncated).toBe(true);
    expect(result.article.mainText.length).toBeLessThanOrEqual(MAX_MAIN_TEXT_CHARS);
    expect(result.article.mainText.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.article.mainText).toContain("Paragraph 1:");
  });

  it("rejects a non-http hero image URL instead of passing it through", () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, index) =>
        `<p>Point ${index + 1}: the committee heard nearly two hours of testimony about the proposal before adjourning, and staff promised a revised draft with updated cost estimates by the next session.</p>`,
    ).join("");
    const html = `<html><head><title>Story</title><meta property="og:image" content="javascript:alert(1)"></head><body><article>${paragraphs}</article></body></html>`;
    const result = extractArticle({ html, finalUrl: "https://example.com/story" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.article.heroImageUrl).toBeUndefined();
  });

  it("falls back to hostname-derived source and final URL canonical when metadata is absent", () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, index) =>
        `<p>Speaker ${index + 1} lined up at the podium for a third straight meeting to weigh in on the rezoning, which would allow four-story buildings along the corridor for the first time.</p>`,
    ).join("");
    const html = `<html><body><main>${paragraphs}</main></body></html>`;
    const result = extractArticle({ html, finalUrl: "https://www.example.org/news/rezoning" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.article.sourceName).toBe("example.org");
    expect(result.article.canonicalUrl).toBe("https://www.example.org/news/rezoning");
    expect(result.article.heroImageUrl).toBeUndefined();
    expect(result.article.byline).toBeUndefined();
  });
});
