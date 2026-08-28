import { defineEmailAction, type AnalysisEmailAction } from "@flock/email-sdk";
import { z } from "zod";

/**
 * `readWebPage` — the ONE model-facing contract for reading a public web page.
 *
 * It replaces `fetchWebContent` and `fetchPersonHighlight`, which were two
 * tools split by WHAT THE PAGE IS ABOUT. That split asked the model to
 * classify a page before anyone had fetched it, so the only evidence it could
 * possibly use was the user's phrasing — and the guidance layer duly grew
 * literal strings like "from my portfolio" and "about me", with a matching
 * keyword regex in the mock so the mock would agree. Pointing it at a
 * portfolio ran a personal homepage through an article extractor.
 *
 * One tool means there is nothing left to route, so the routing rule, the
 * keyword regex, and every mutual-exclusion sentence in the two old
 * descriptions all disappear as a consequence of the shape rather than as a
 * cleanup somebody has to remember to do.
 *
 * Note what this description does NOT do: it never says what kind of page to
 * use it on, because there is no other tool to send the model to instead. A
 * description that names page kinds is the fork trying to grow back inside a
 * string.
 *
 * The agent package owns the model-facing surface (name, description, input
 * schema, payload shape) so the prompt layers and this contract cannot drift.
 * The fetch and extraction implementation lives in the web app, which owns the
 * SSRF-guarded `fetchPage` primitive, and is INJECTED — only the host app can
 * perform network I/O.
 */

// ---------------------------------------------------------------------------
// Input (what the model sends)
// ---------------------------------------------------------------------------

export const readWebPageInputSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(2048)
      .describe("The full http(s) URL of the page to read, exactly as the user gave it."),
  })
  .describe("Input for readWebPage: the one public web page to fetch and read.");

export type ReadWebPageInput = z.infer<typeof readWebPageInputSchema>;

// ---------------------------------------------------------------------------
// Result payload (what the model gets back)
// ---------------------------------------------------------------------------

/** One block of prose the page wrote, in document order. */
export interface ReadWebPageBlock {
  kind: "heading" | "paragraph";
  text: string;
}

/**
 * A list the page wrote.
 *
 * This channel exists because the shared prose collector kept a list item only
 * when it ran past 60 characters with almost no link text — a rule tuned for
 * news articles, where it correctly firewalls menus. A skills list is
 * "TypeScript", "React", "Design systems", so that rule discarded it before
 * the model ever saw it. Judging the LIST by its link density rather than the
 * ITEM by its length keeps the content and still drops the navigation.
 */
export interface ReadWebPageList {
  headingBefore?: string;
  items: string[];
}

/** What kind of page the reader decided this was. An OUTPUT, never a branch. */
export type ReadWebPageType =
  | "person_profile"
  | "portfolio"
  | "article"
  | "product"
  | "organization"
  | "event"
  | "collection"
  | "reference"
  | "other";

/** How much the reading of this page can be trusted. */
export type ReadWebPageConfidence = "high" | "medium" | "low";

/** One image the pipeline kept, already stored on our own servers. */
export interface ReadWebPageImage {
  /** Absolute URL in Flock's storage. Never the original site's address. */
  url: string;
  role: "portrait" | "logo" | "lead" | "supporting";
  alt?: string;
  /** Who or what it shows, when the reader could say. */
  subject?: string;
}

/**
 * One planned email section: a catalog template plus the copy this page's own
 * content makes. Pass these to createDraft as they are.
 */
export interface ReadWebPageSection {
  templateId: string;
  params: Record<string, unknown>;
  /** Which numbered content lines this section's copy came from. */
  sourceBlockIndices: number[];
  /** One line: what on the page this section is. */
  rationale: string;
}

/**
 * One claim found beyond the page, with the source that carried it.
 *
 * Every claim keeps its own address. That is what makes "never paraphrase into
 * fabrication" checkable rather than aspirational for anything sourced from
 * outside the page the user actually pointed at.
 */
export interface ReadWebPageSearchClaim {
  text: string;
  sourceUrl: string;
  sourceTitle: string;
}

/** The page's content, as read. */
export interface ReadWebPagePayload {
  /** The page's title (og:title / JSON-LD headline / <title>). */
  title: string;
  /** Human-readable site name (og:site_name, or the hostname). */
  sourceName: string;
  /** The canonical URL — USE THIS for any attribution link. */
  canonicalUrl: string;
  /** The page's own summary (meta description), when it has one. */
  description?: string;
  /** Prose in reading order. Order is evidence; do not reorder it casually. */
  blocks: ReadWebPageBlock[];
  /** Lists the page wrote as lists, rather than as prose. */
  lists: ReadWebPageList[];
  /**
   * Every JSON-LD node the page's publisher declared about itself, `@graph`
   * members flattened and NO type filter applied. When this disagrees with the
   * prose, prefer it for names, titles, prices, and dates.
   */
  structuredData: Record<string, unknown>[];
  /**
   * Up to four images, already copied into Flock's own storage and each given
   * a role. An image that could not be stored is DROPPED, never hot-linked
   * from the original site.
   */
  images: ReadWebPageImage[];
  /** True when the page was long enough that trailing content was cut. */
  isTruncated: boolean;

  /*
    What the reader made of the page. These are OUTPUTS of reading it, and
    nothing downstream may switch on `pageType` — it is here so you can say
    what you read, not so anything can branch on it.
  */
  pageType: ReadWebPageType;
  /** Present when pageType is "other": what the page actually is. */
  pageTypeNote?: string;
  /**
   * How much to trust this reading.
   *
   * "high"   — build, and name what you read.
   * "medium" — build, AND relay uncertaintyNote and invite a correction.
   * "low"    — do NOT build. isPlanUsable is false; relay `message` and stop.
   */
  confidence: ReadWebPageConfidence;
  /** Present at "medium": the one thing that is unclear. Relay it. */
  uncertaintyNote?: string;
  /**
   * The email this page's content would make, in reading order — ready to hand
   * straight to createDraft. Image addresses are already filled in for you.
   */
  sections: ReadWebPageSection[];
  /** The reader's own account of the page, up to 400 characters. */
  sourceSummary: string;
  /** False when there was not enough on the page to build an honest email. */
  isPlanUsable: boolean;
  /** What to tell the user when isPlanUsable is false. */
  message?: string;
  /**
   * Claims found beyond this page, present ONLY when the reader named a
   * subject worth looking up AND public-web search is switched on. Absent is
   * the normal case, and absence means nothing was consulted — never imply
   * wider research than this carries.
   */
  searchClaims?: ReadWebPageSearchClaim[];
}

/**
 * Success carries what was on the page; refusal carries a machine `reason`
 * plus a user-relayable `message`.
 *
 * A REFUSAL IS NOT AN ERROR. A page that is disallowed by robots.txt,
 * paywalled, or carries no readable content comes back as a SUCCESSFUL tool
 * output with `isOk: false` and something to say, because that is information
 * the model must relay before stopping. Throwing would put it on the error
 * path, where the model is invited to retry — exactly the wrong instinct for a
 * page that cannot be read.
 */
export type ReadWebPageResult =
  | { isOk: true; page: ReadWebPagePayload }
  | { isOk: false; reason: string; message: string };

/** The injected implementation: SSRF-guarded fetch, then generic extraction. */
export type ReadWebPageFn = (input: { url: string }) => Promise<ReadWebPageResult>;

// ---------------------------------------------------------------------------
// Action definition (executor injected by the host app)
// ---------------------------------------------------------------------------

/**
 * Define the `readWebPage` analysis action around a host-provided
 * fetch/extract implementation. Read-only by construction: it never touches
 * the document (the `doc` argument is ignored).
 */
export function defineReadWebPageAction({
  readWebPage,
}: {
  readWebPage: ReadWebPageFn;
}): AnalysisEmailAction<typeof readWebPageInputSchema, Promise<ReadWebPageResult>> {
  return defineEmailAction({
    name: "readWebPage",
    description:
      "Fetch ONE public web page server-side and return what is ACTUALLY on it: its title, the site's name, the canonical URL, the page's own description, its prose in reading order, the lists it wrote, the structured data its publisher declared about itself, and its lead image copied into Flock's storage. Navigation, ads, and comments are stripped, and a long page is truncated. Read-only; the document is unchanged. Call it BEFORE building anything from a page the user pointed at, and write only from what comes back — do not add a fact, a number, a date, or a name that is not in the payload. If the result has isOk: false the page could not be read: relay the message to the user, make no edits, and never guess at what the page says.",
    kind: "analysis",
    schema: readWebPageInputSchema,
    readOnly: true,
    parallelSafe: true,
    needsApproval: false,
    run: (_doc, input): Promise<ReadWebPageResult> => readWebPage({ url: input.url }),
  });
}
