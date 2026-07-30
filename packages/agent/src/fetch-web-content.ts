import { defineEmailAction, type AnalysisEmailAction } from "@tandem/email-sdk";
import { z } from "zod";

/**
 * `fetchWebContent` — the Phase 7.4(a) read-only web-content tool CONTRACT.
 *
 * The agent package owns the model-facing surface (name, description, input
 * schema, result payload shape) so the prompt layers and this contract can
 * never drift apart; the actual fetch + extraction implementation lives in
 * the web app (it builds on apps/web's SSRF-guarded `fetchPage` primitive)
 * and is INJECTED via {@link defineFetchWebContentAction} — same dependency
 * direction as getBlockDetails, inverted: there the agent had the
 * implementation; here only the host app can perform network I/O.
 *
 * Faithfulness contract (plan §7.4 — LAW): the payload carries the page's
 * ACTUAL extracted content or an honest structured refusal. There is no
 * third state; the model must compose only from `article` fields and must
 * relay `message` and stop when `isOk` is false.
 */

// ---------------------------------------------------------------------------
// Input (what the model sends)
// ---------------------------------------------------------------------------

export const fetchWebContentInputSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(2048)
      .describe(
        "The full http(s) URL of the article or page to read, exactly as the user gave it.",
      ),
  })
  .describe("Input for fetchWebContent: the one public web page to fetch and read.");

export type FetchWebContentInput = z.infer<typeof fetchWebContentInputSchema>;

// ---------------------------------------------------------------------------
// Result payload (what the model gets back)
// ---------------------------------------------------------------------------

/** How sure the extractor is that `mainText` is the page's real main content. */
export type WebContentConfidence = "high" | "medium" | "low";

/** The bounded, structured article payload returned on a successful read. */
export interface WebArticlePayload {
  /** The article's title (og:title / JSON-LD headline / <title>). */
  title: string;
  /** The author line, when the page declares one. */
  byline?: string;
  /** Publication timestamp/date as the page declared it (not normalized). */
  publishedAt?: string;
  /** Human-readable source name (og:site_name or the hostname). */
  sourceName: string;
  /** The canonical URL of the page — USE THIS for the attribution link. */
  canonicalUrl: string;
  /** The page's lead/social image (absolute https URL), when it has one. */
  heroImageUrl?: string;
  /** The page's own summary (meta description), when present. */
  excerpt?: string;
  /**
   * The extracted main content, ads/navigation/comments stripped, capped to a
   * context-window-safe budget. When `isTruncated` is true it ends with a
   * "[content truncated …]" marker and the full text lives only at the source.
   */
  mainText: string;
  /** True when mainText hit the cap and was cut off. */
  isTruncated: boolean;
  /** Extraction confidence — relay doubts to the user when this is "low". */
  confidence: WebContentConfidence;
}

/**
 * Success carries the real extracted article; refusal carries a machine
 * `reason` plus a user-relayable `message`. `reason` values come from the
 * fetch layer (e.g. "blocked_by_site", "dns", "timeout", "not_html") and the
 * extraction layer ("paywalled", "no_main_content").
 */
export type FetchWebContentResult =
  | { isOk: true; article: WebArticlePayload }
  | { isOk: false; reason: string; message: string };

/** The injected implementation: SSRF-guarded fetch + main-content extraction. */
export type FetchWebArticleFn = (input: { url: string }) => Promise<FetchWebContentResult>;

// ---------------------------------------------------------------------------
// Action definition (executor injected by the host app)
// ---------------------------------------------------------------------------

/**
 * Define the `fetchWebContent` analysis action around a host-provided
 * fetch/extract implementation. Read-only by construction: it never touches
 * the document (the `doc` argument is ignored).
 */
export function defineFetchWebContentAction({
  fetchWebArticle,
}: {
  fetchWebArticle: FetchWebArticleFn;
}): AnalysisEmailAction<typeof fetchWebContentInputSchema, Promise<FetchWebContentResult>> {
  return defineEmailAction({
    name: "fetchWebContent",
    description:
      "Fetch ONE public web page (news article, blog post) server-side and return its ACTUAL main content — title, byline, date, source name, canonical URL, lead image, and the article text with navigation, ads, and comments stripped (long articles are truncated). Read-only; the document is unchanged. Call it BEFORE building anything from a URL the user shared. If the result has isOk: false the page could not be read: tell the user why (relay the message), make no edits, and never guess at what the page says.",
    kind: "analysis",
    schema: fetchWebContentInputSchema,
    readOnly: true,
    parallelSafe: true,
    needsApproval: false,
    run: (_doc, input): Promise<FetchWebContentResult> => fetchWebArticle({ url: input.url }),
  });
}
