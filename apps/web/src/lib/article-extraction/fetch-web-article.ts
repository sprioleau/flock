import type { FetchWebContentResult } from "@tandem/agent";
import { fetchPage, type FetchFailureReason } from "../brand-kit-extraction/fetch-page";
import { extractArticle } from "./extract-article";

/**
 * The Phase 7.4(a) fetchWebContent EXECUTOR — injected into
 * buildAgentActionRegistry by the chat route's registry module.
 *
 * Composition, not a fork: the mode-agnostic `fetchPage` primitive (SSRF
 * guard per redirect hop, 2MB/10s caps, honest failures) does the fetching;
 * `extractArticle` (pure) does the reading. This module only adapts failure
 * copy — fetch-page's user-facing messages were written for the brand-kit
 * mode ("we won't guess at its branding"), so article-mode fetches re-say
 * the same honest facts in article terms. Machine `reason` codes pass
 * through unchanged.
 */

/** Article-mode overrides for fetch failures whose stock copy is brand-kit-flavored. */
const ARTICLE_FAILURE_MESSAGES: Partial<Record<FetchFailureReason, string>> = {
  blocked_by_site:
    "That site wouldn't let the page be read (it blocks automated access). No content was invented in its place — try a different link to the same story.",
  not_html:
    "That address isn't a readable web page (it may be a file or a feed). Try a direct link to the article itself.",
};

/** Fetch one public page and extract its main article content — or refuse honestly. */
export async function fetchWebArticle({ url }: { url: string }): Promise<FetchWebContentResult> {
  const page = await fetchPage(url);
  if (!page.isOk) {
    return {
      isOk: false,
      reason: page.reason,
      message: ARTICLE_FAILURE_MESSAGES[page.reason] ?? page.message,
    };
  }
  return extractArticle({ html: page.html, finalUrl: page.finalUrl });
}
