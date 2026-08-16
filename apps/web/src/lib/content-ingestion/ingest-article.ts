import type { FetchWebContentResult } from "@flock/agent";
import { fetchPage, type FetchFailureReason } from "../brand-kit-extraction/fetch-page";
import { extractArticle } from "./extract-article";
import { rehostImageToStorage } from "./rehost-image";
import { isFetchAllowedByRobots } from "./robots";

/**
 * The Phase 7.4(a) article pipeline: ONE public URL in, the page's ACTUAL
 * article content out — or an honest refusal.
 *
 * Stages, in order, each able to stop the pipeline:
 *   1. robots.txt   — if the site's own rules disallow the path, we stop
 *                     BEFORE any page fetch (robots.ts fails open on an
 *                     unreachable robots.txt, closed on an explicit Disallow).
 *   2. fetchPage    — the shared, mode-agnostic fetch primitive: SSRF guard on
 *                     every redirect hop, 10s deadline, 2MB cap, honest
 *                     failure reasons (blocked_by_site, not_html, dns, …).
 *   3. extractArticle — pure readability-style extraction, including the
 *                     paywall and no-main-content refusals.
 *   4. hero rehost  — the extracted lead image is copied into Convex storage
 *                     so the composed email never hot-links a CDN that may
 *                     refuse the browser. Fail-soft: no image beats a broken
 *                     one, and never a made-up one.
 *
 * Composition, not a fork — this module owns only the ordering and the
 * article-mode failure copy. `fetchPage`'s user-facing messages were written
 * for brand-kit mode ("we won't guess at its branding"), so article-mode
 * fetches re-say the same honest facts in article terms. Machine `reason`
 * codes pass through unchanged so callers can branch on them.
 */

/** Article-mode overrides for fetch failures whose stock copy is brand-kit-flavored. */
const ARTICLE_FAILURE_MESSAGES: Partial<Record<FetchFailureReason, string>> = {
  blocked_by_site:
    "That site wouldn't let the page be read (it blocks automated access). No content was invented in its place — try a different link to the same story.",
  /*
    The origin-wide case needs the OPPOSITE ending from blocked_by_site above:
    every path on that host answers with the same bot check, so "try a
    different link to the same story" is a loop. Article mode has to say it in
    article terms — the stock brand-kit copy points at the brand-kit panel,
    which means nothing to someone ingesting a news page.
  */
  blocked_by_bot_challenge:
    "That site blocks automated readers, so no page on it can be read — another link to the same story won't get through either. No content was invented in its place; paste the text you'd like to use.",
  not_html:
    "That address isn't a readable web page (it may be a file or a feed). Try a direct link to the article itself.",
};

/** The refusal returned when the site's robots.txt disallows the path. */
export const ROBOTS_REFUSAL: FetchWebContentResult = {
  isOk: false,
  reason: "blocked_by_robots",
  message:
    "That site's robots.txt asks automated readers to stay off that page, so it wasn't fetched. Nothing was made up in its place — paste the text you'd like to use, or try a page the site allows.",
};

export interface IngestArticleInput {
  /** The page to read, exactly as the user gave it. */
  url: string;
  /**
   * Session that should own a rehosted hero image (it joins that session's
   * Asset Library). Null still rehosts — the file is just unowned.
   */
  sessionId?: string | null;
  /**
   * False skips the hero-image rehost and drops the image entirely. Used by
   * unit tests and by callers with no storage configured.
   */
  shouldRehostHeroImage?: boolean;
}

/**
 * Fetch one public page and extract its main article content — or refuse
 * honestly. This is the fetchWebContent tool's executor and the
 * POST /api/ingest article path; both share this exact behavior.
 */
export async function ingestArticle({
  url,
  sessionId = null,
  shouldRehostHeroImage = true,
}: IngestArticleInput): Promise<FetchWebContentResult> {
  if (!(await isFetchAllowedByRobots(url))) {
    return ROBOTS_REFUSAL;
  }
  const page = await fetchPage(url);
  if (!page.isOk) {
    return {
      isOk: false,
      reason: page.reason,
      message: ARTICLE_FAILURE_MESSAGES[page.reason] ?? page.message,
    };
  }
  const extracted = extractArticle({ html: page.html, finalUrl: page.finalUrl });
  if (!extracted.isOk || extracted.article.heroImageUrl === undefined) {
    return extracted;
  }
  const { heroImageUrl, ...articleWithoutHero } = extracted.article;
  if (!shouldRehostHeroImage) {
    return { isOk: true, article: articleWithoutHero };
  }
  const rehostedUrl = await rehostImageToStorage({
    imageUrl: heroImageUrl,
    sessionId,
    name: extracted.article.title,
    sourceUrl: extracted.article.canonicalUrl,
  });
  // A lead image that couldn't be stored is DROPPED, not hot-linked: a URL
  // that renders here can still be refused in the recipient's inbox.
  return rehostedUrl === null
    ? { isOk: true, article: articleWithoutHero }
    : { isOk: true, article: { ...articleWithoutHero, heroImageUrl: rehostedUrl } };
}

/**
 * The session-less adapter injected into the agent action registry (a
 * module-level singleton, so it cannot close over a request's session). The
 * chat route fulfills the tool host-side with the caller's session — see
 * app/api/chat/tools.ts.
 */
export async function fetchWebArticle({ url }: { url: string }): Promise<FetchWebContentResult> {
  return ingestArticle({ url });
}
