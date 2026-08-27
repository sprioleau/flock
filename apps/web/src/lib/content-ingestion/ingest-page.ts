import type {
  ReadWebPageBlock,
  ReadWebPageList,
  ReadWebPagePayload,
  ReadWebPageResult,
} from "@flock/agent";
import { fetchPage, type FetchFailureReason } from "../brand-kit-extraction/fetch-page";
import { extractPage } from "./extract-page";
import type { ImageCandidate, PageScrape } from "./page-scrape";
import { rehostImageToStorage } from "./rehost-image";
import { isFetchAllowedByRobots } from "./robots";

/**
 * The generic page pipeline: ONE public URL in, what the page ACTUALLY says
 * out — or an honest refusal.
 *
 * This replaces `ingest-article.ts` and `ingest-person.ts`, which were the same
 * four stages twice over, forked on a page type chosen from the user's sentence
 * before a single byte had been fetched. There is no page type at this layer.
 * Nothing below branches on one, and nothing below may: a page type is a later
 * step's OUTPUT, and a `switch` over it here is the deleted fork growing back.
 *
 * Stages, in order, each able to stop the pipeline:
 *   1. robots.txt  — the site's own rules decide whether we may read it, BEFORE
 *                    any page fetch. `robots.ts` fails OPEN on an unreachable
 *                    robots.txt and CLOSED on an explicit Disallow.
 *   2. fetchPage   — the shared, mode-agnostic fetch primitive: SSRF guard on
 *                    every redirect hop, 5 redirects, 10s deadline, 2MB cap,
 *                    typed failure reasons.
 *   3. extractPage — pure HTML → `PageScrape`, including the paywall and
 *                    no-readable-content refusals.
 *   4. lead image  — EXACTLY ONE image is copied into Convex storage, so a
 *                    composed email never hot-links a CDN that may refuse the
 *                    recipient's browser. Fail-soft: an image that cannot be
 *                    stored is DROPPED, never hot-linked and never invented.
 *
 * THE HOUSE RULE: A REFUSAL IS NOT AN ERROR. robots Disallow, a fetch failure,
 * a paywall, and no readable content all come back as a SUCCESSFUL call
 * returning `{ isOk: false, reason, message }` with something worth relaying.
 * Throwing would put an unreadable page on the error path, where the model is
 * invited to retry — exactly the wrong instinct.
 */

/*
  Page-mode overrides for fetch failures whose stock copy is brand-kit-flavored
  ("we won't guess at its branding" means nothing to someone reading a page).

  ONE table, not two. The old pipelines carried ARTICLE_FAILURE_MESSAGES and
  PROFILE_FAILURE_MESSAGES saying the same three things in two vocabularies —
  the page-type fork surviving inside strings. Machine `reason` codes still pass
  through untouched so callers can branch on them.
*/
const PAGE_FAILURE_MESSAGES: Partial<Record<FetchFailureReason, string>> = {
  blocked_by_site:
    "That site wouldn't let the page be read (it blocks automated access). Nothing was invented in its place — try a different link, or paste the text you'd like to use.",
  /*
    The origin-wide case needs the OPPOSITE ending from blocked_by_site above:
    every path on that host answers with the same bot check, so "try a different
    link" is a loop with no way out.
  */
  blocked_by_bot_challenge:
    "That site blocks automated readers, so no page on it can be read — another link to the same site won't get through either. Nothing was invented in its place; paste the text you'd like to use.",
  not_html:
    "That address isn't a readable web page (it may be a file or a feed). Try a direct link to the page itself.",
};

/** The refusal returned when the site's robots.txt disallows the path. */
export const PAGE_ROBOTS_REFUSAL: ReadWebPageResult = {
  isOk: false,
  reason: "blocked_by_robots",
  message:
    "That site's robots.txt asks automated readers to stay off that page, so it wasn't fetched. Nothing was made up in its place — paste the text you'd like to use, or try a page the site allows.",
};

/**
 * Image origins that may serve as the page's lead image, best first.
 *
 * This is a preference over EVIDENCE (where the page put the image), not over
 * subject matter. `og-image` is the picture the publisher itself nominated for
 * a link preview, which is the closest thing to a declared lead image any page
 * offers; structured data is the same claim in another vocabulary; an inline
 * image is the page's first real picture. `link-icon` is deliberately absent —
 * a favicon is never a lead image, and rehosting one wastes the single copy.
 */
const LEAD_IMAGE_ORIGIN_PREFERENCE = ["og-image", "structured-data", "inline"] as const;

/**
 * Hints that disqualify a candidate from standing in as the lead, at ANY
 * origin — a page that nominates a 32×32 glyph as its og:image has not
 * nominated a lead image, it has nominated a favicon by another route.
 */
const NON_LEAD_HINTS = ["icon-ish", "small"];

/**
 * The one image worth copying: the og:image candidate, else the structured-data
 * one, else the page's first inline picture — skipping chrome icons at every
 * tier.
 */
export function selectLeadImageCandidate(
  candidates: ImageCandidate[],
): ImageCandidate | undefined {
  for (const origin of LEAD_IMAGE_ORIGIN_PREFERENCE) {
    const found = candidates.find(
      (candidate) =>
        candidate.origin === origin &&
        !candidate.hints.some((hint) => NON_LEAD_HINTS.includes(hint)),
    );
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * `PageScrape` → `ReadWebPagePayload`, field by field.
 *
 * Written out rather than spread, because the difference between the two types
 * is the point: `linkDensity` is INTERNAL EVIDENCE for admitting a list, not
 * something the model needs, so it is dropped here. A `...list` spread would
 * silently leak it back in the first time either type gains a field.
 */
function toPayload({
  scrape,
  leadImageUrl,
}: {
  scrape: PageScrape;
  leadImageUrl: string | null;
}): ReadWebPagePayload {
  const blocks: ReadWebPageBlock[] = scrape.blocks.map((block) => ({
    kind: block.kind,
    text: block.text,
  }));
  const lists: ReadWebPageList[] = scrape.lists.map((list) => ({
    ...(list.headingBefore === undefined ? {} : { headingBefore: list.headingBefore }),
    items: list.items,
  }));
  return {
    title: scrape.title,
    sourceName: scrape.siteName,
    canonicalUrl: scrape.canonicalUrl,
    ...(scrape.description === undefined ? {} : { description: scrape.description }),
    blocks,
    lists,
    structuredData: scrape.structuredData,
    ...(leadImageUrl === null ? {} : { leadImageUrl }),
    isTruncated: scrape.isTruncated,
  };
}

export interface IngestPageInput {
  /** The page to read, exactly as the user gave it. */
  url: string;
  /**
   * Session that should own the rehosted lead image (it joins that session's
   * Asset Library). Null still rehosts — the file is just unowned.
   */
  sessionId?: string | null;
  /**
   * False skips the lead-image rehost and drops the image entirely. Used by
   * unit tests and by callers with no storage configured.
   */
  shouldRehostLeadImage?: boolean;
}

/**
 * Fetch one public page and read what is on it — or refuse honestly. This is
 * the `readWebPage` action's executor and the POST /api/ingest path; both share
 * this exact behavior.
 */
export async function ingestPage({
  url,
  sessionId = null,
  shouldRehostLeadImage = true,
}: IngestPageInput): Promise<ReadWebPageResult> {
  if (!(await isFetchAllowedByRobots(url))) {
    return PAGE_ROBOTS_REFUSAL;
  }
  const page = await fetchPage(url);
  if (!page.isOk) {
    return {
      isOk: false,
      reason: page.reason,
      message: PAGE_FAILURE_MESSAGES[page.reason] ?? page.message,
    };
  }
  const extracted = extractPage({ html: page.html, finalUrl: page.finalUrl });
  if (!extracted.isOk) {
    return extracted;
  }
  const { scrape } = extracted;

  const leadCandidate = shouldRehostLeadImage
    ? selectLeadImageCandidate(scrape.imageCandidates)
    : undefined;
  /*
    EXACTLY ONE rehost per ingest. Copying more would spend a network round trip
    and a stored file per image on a page that offers a dozen candidates, to
    serve a composer that can only place one lead.
  */
  const leadImageUrl =
    leadCandidate === undefined
      ? null
      : await rehostImageToStorage({
          imageUrl: leadCandidate.sourceUrl,
          sessionId,
          name: scrape.title,
          sourceUrl: scrape.canonicalUrl,
        });

  return { isOk: true, page: toPayload({ scrape, leadImageUrl }) };
}

/**
 * The session-less adapter injected into the agent action registry (a
 * module-level singleton, so it cannot close over a request's session). The
 * chat route fulfills the action host-side with the caller's session — see
 * app/api/chat/tools.ts.
 */
export async function readWebPage({ url }: { url: string }): Promise<ReadWebPageResult> {
  return ingestPage({ url });
}
