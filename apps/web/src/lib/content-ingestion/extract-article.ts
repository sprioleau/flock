import type { FetchWebContentResult, WebContentConfidence } from "@flock/agent";
import {
  collectProseBlocks,
  MAX_PAYWALLED_TEASER_CHARS,
  MIN_MAIN_TEXT_CHARS,
  NO_MAIN_CONTENT_REFUSAL_MESSAGE,
  NON_CONTENT_TAGS,
  PAYWALL_REFUSAL_MESSAGE,
  PAYWALL_TEXT_PATTERN,
  readPageMetadata,
  removeJunkBlocks,
  removeTagBlocks,
  selectContentScope,
  toAbsoluteHttpUrl,
  toPlainText,
} from "./extract-page";

/**
 * Article extraction (Phase 7.4a) — pure HTML → the page's ACTUAL main
 * content, no network, no LLM, no DOM dependency.
 *
 * Readability-style heuristics at regex scale (the same honest-harvesting
 * philosophy as ../brand-kit-extraction/harvest.ts — every sentence in the
 * output was literally present in the fetched markup):
 *
 * 1. Scope: prefer the largest <article> element, then <main>, then <body>.
 * 2. Strip non-content subtrees (script/style/nav/aside/footer/header/forms/
 *    figures) plus any element whose class/id smells like ads, comments,
 *    menus, share bars, or newsletter promos — depth-aware tag matching, so
 *    whole subtrees go, not just tags.
 * 3. Keep paragraph-shaped blocks (h1–h3, p, li, blockquote) that read like
 *    prose: enough text, low link density, no boilerplate phrasing. This is
 *    what keeps menus and "related stories" link farms out of mainText.
 * 4. Honest failures: paywall/sign-in stubs and pages with no readable prose
 *    return a structured refusal — never a fabricated article (plan §7.4).
 *
 * Metadata (title/byline/date/source/hero image/canonical URL) comes from
 * OpenGraph tags, JSON-LD Article objects, and standard fallbacks.
 *
 * The parser this is built on now lives in extract-page.ts — tag stripping,
 * junk removal, scope selection, prose collection, metadata reading, and the
 * two refusal conditions. This file is only the ARTICLE ASSEMBLER: what to do
 * with those parts once you have already decided the page is an article.
 */

// ---------------------------------------------------------------------------
// Budgets & thresholds
// ---------------------------------------------------------------------------

/** Context-window budget for mainText (chars, ~1.2k tokens). */
export const MAX_MAIN_TEXT_CHARS = 5_000;

/** Marker appended when mainText hits the cap (isTruncated is also set). */
export const TRUNCATION_MARKER = "[content truncated — the full article is at the source]";

const MAX_EXCERPT_CHARS = 300;

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export interface ExtractArticleInput {
  /** The fetched page HTML (already capped by fetchPage). */
  html: string;
  /** The post-redirect URL — the base for resolving relative URLs. */
  finalUrl: string;
}

/**
 * Extract the page's main article content, or refuse honestly. Pure and
 * deterministic — safe to unit-test on saved fixtures.
 */
export function extractArticle({ html, finalUrl }: ExtractArticleInput): FetchWebContentResult {
  const metadata = readPageMetadata(html);

  // Order matters: junk-class subtrees first (they may CONTAIN structural
  // tags whose removal would otherwise splice around them), then structural
  // non-content tags.
  const { scopeHtml, scopeKind } = selectContentScope(html);
  let cleanedScope = removeJunkBlocks(scopeHtml);
  for (const tagName of NON_CONTENT_TAGS) {
    cleanedScope = removeTagBlocks({ html: cleanedScope, tagName });
  }

  const proseBlocks = collectProseBlocks(cleanedScope);
  const fullText = proseBlocks.map((block) => block.text).join("\n\n");

  const hasPaywallSignal =
    metadata.isDeclaredPaywalled || PAYWALL_TEXT_PATTERN.test(toPlainText(cleanedScope));
  if (hasPaywallSignal && fullText.length < MAX_PAYWALLED_TEASER_CHARS) {
    return {
      isOk: false,
      reason: "paywalled",
      message: PAYWALL_REFUSAL_MESSAGE,
    };
  }

  if (fullText.length < MIN_MAIN_TEXT_CHARS) {
    return {
      isOk: false,
      reason: "no_main_content",
      message: NO_MAIN_CONTENT_REFUSAL_MESSAGE,
    };
  }

  let mainText = fullText;
  let isTruncated = false;
  if (mainText.length > MAX_MAIN_TEXT_CHARS) {
    const budget = MAX_MAIN_TEXT_CHARS - TRUNCATION_MARKER.length - 2;
    const cut = mainText.slice(0, budget);
    const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
    mainText = `${cut.slice(0, lastBreak > budget / 2 ? lastBreak : budget).trimEnd()}…\n\n${TRUNCATION_MARKER}`;
    isTruncated = true;
  }

  const sourceHostname = new URL(finalUrl).hostname.replace(/^www\./i, "");
  const sourceName = metadata.ogSiteName ?? metadata.ldPublisher ?? sourceHostname;

  let title = metadata.ogTitle ?? metadata.ldHeadline ?? metadata.titleTag ?? sourceName;
  const escapedSourceName = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  title = title.replace(new RegExp(`\\s*[|–—-]\\s*${escapedSourceName}\\s*$`, "i"), "").trim();
  if (title.length === 0) {
    title = sourceName;
  }

  const canonicalUrl =
    toAbsoluteHttpUrl({ candidate: metadata.canonicalHref, baseUrl: finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ogUrl, baseUrl: finalUrl }) ??
    finalUrl;
  const heroImageUrl =
    toAbsoluteHttpUrl({ candidate: metadata.ogImage, baseUrl: finalUrl }) ??
    toAbsoluteHttpUrl({ candidate: metadata.ldImage, baseUrl: finalUrl });
  const byline = metadata.metaAuthor ?? metadata.ldAuthor;
  const publishedAt = metadata.publishedTime ?? metadata.ldDatePublished;
  const excerpt =
    metadata.description === undefined
      ? undefined
      : metadata.description.slice(0, MAX_EXCERPT_CHARS);

  const hasStructuredTitle = metadata.ogTitle !== undefined || metadata.ldHeadline !== undefined;
  let confidence: WebContentConfidence;
  if (scopeKind !== "body" && fullText.length >= 1_500 && hasStructuredTitle) {
    confidence = "high";
  } else if (fullText.length >= 600 && (scopeKind !== "body" || hasStructuredTitle)) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    isOk: true,
    article: {
      title,
      ...(byline === undefined ? {} : { byline }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      sourceName,
      canonicalUrl,
      ...(heroImageUrl === undefined ? {} : { heroImageUrl }),
      ...(excerpt === undefined ? {} : { excerpt }),
      mainText,
      isTruncated,
      confidence,
    },
  };
}
