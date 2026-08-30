/*
  `PageScrape` — what ONE fetched page looks like once it has been read, and
  BEFORE anyone has decided what kind of page it is.

  This type is the whole architecture in one place, so it is worth saying why
  it looks like this.

  The pipeline it replaces chose an extractor from the user's sentence:
  `fetchWebContent` (an article reader) or `fetchPersonHighlight` (a person
  reader), picked before a single byte had been fetched. The only evidence
  available at that moment is how the user phrased the request, so the choice
  was a rule about sentences — it embedded literal strings like "from my
  portfolio" and "about me" in the prompt layer, and a fifteen-keyword regex
  in the mock so the mock would agree with it. A new kind of page needed a new
  keyword. Pointing it at a portfolio ran a personal homepage through an
  article extractor and produced an email about nothing.

  So the decision moved downstream of the evidence. One generic scrape, then a
  reading of what was actually scraped.

  THE RULE THAT KEEPS THIS HONEST: every field below is TYPE-NEUTRAL. There is
  no branch in the module that produces this, and no field that only makes
  sense for one kind of page. A page type is something a later step OUTPUTS
  from this evidence; it is never an input to a branch. If a future commit
  writes `switch (pageType)` over this data, the fork has grown back one level
  down and this design has been undone.
*/

/*
  One block of prose the page wrote. Carried here rather than imported from
  the extractor so this file is the whole contract and depends on nothing.
*/
export interface ProseBlock {
  kind: "heading" | "paragraph";
  text: string;
}

/*
  A list the page wrote, grouped by its parent `<ul>`/`<ol>`.

  This is a genuinely new channel and it exists because of a specific bug.
  `collectProseBlocks` keeps an `li` only when `text.length >= 60 &&
  linkDensity <= 0.2` — a rule tuned for news articles, where it is the menus
  firewall and correct. But a skills list is "TypeScript", "React", "Design
  systems": every item far under 60 characters. The engine both old extractors
  shared therefore discarded, before the model ever saw it, exactly the kind
  of content a portfolio is made of.

  The fix is to judge the LIST rather than the ITEM. A navigation list is
  close to 100% link text; a skills list is close to 0%. So items are admitted
  on their list's link density, and `linkDensity` is carried through here
  rather than being consumed and thrown away — a reader can then see WHY a
  list was admitted, and the threshold stays auditable instead of becoming
  folklore.
*/
export interface ScrapedList {
  /*
    The nearest heading above this list, when the page has one.
  */
  headingBefore?: string;
  items: string[];
  /*
    Link text length over total text length, for the list as a whole.
  */
  linkDensity: number;
}

/*
  Where an image candidate was found. Evidence, not a decision.

  `css-background` is a picture the page paints rather than marks up: an
  inline `style="background-image:url(…)"` on some enclosing element. It is a
  separate origin because it is separate EVIDENCE — a background carries no
  `alt` and no intrinsic size, and what it is doing on the page has to be read
  from the element it sits on rather than from the tag itself.
*/
export type ImageOrigin =
  | "og-image"
  | "structured-data"
  | "inline"
  | "link-icon"
  | "css-background";

/*
  One image the page offers, with enough context around it for a later step to
  assign it a role.

  The pipeline keeps the model away from URLs entirely: a later step refers to
  a candidate by `id` and never emits an address. An id that is not in the
  candidate list is dropped before any network call, so there is no syntax
  available for inventing an image.
*/
export interface ImageCandidate {
  /*
    The handle a later step refers to this by: "img_1", "img_2", …
  */
  id: string;
  /*
    Absolute http(s), already resolved against the page's final URL.
  */
  sourceUrl: string;
  alt?: string;
  /*
    From the tag's OWN width/height attributes. No probe and no fetch — this
    runs before anyone has decided which images are worth spending bytes on.
  */
  width?: number;
  height?: number;
  documentOrder: number;
  nearestHeading?: string;
  /*
    Roughly 200 characters around the tag.
  */
  surroundingText?: string;
  origin: ImageOrigin;
  /*
    Weak signals, deliberately NOT decisions — e.g. "portrait-ish",
    "logo-ish". The old person extractor's PORTRAIT_HINT_PATTERN survives
    here, demoted from a picker to a hint. That demotion is this whole design
    in miniature: the same regex, no longer allowed to decide anything.
  */
  hints: string[];
}

/*
  The scrape itself. Everything a page gave up, before interpretation.
*/
export interface PageScrape {
  /*
    Identity. Never dropped by the budget under any circumstance — losing
    these is precisely how a pipeline produces an email about nothing.
  */
  finalUrl: string;
  canonicalUrl: string;
  siteName: string;
  title: string;
  description?: string;
  /*
    Prose in DOCUMENT ORDER. The order is itself evidence: three paragraphs
    following a heading called "Experience" mean something those same three
    paragraphs do not mean alone.
  */
  blocks: ProseBlock[];
  lists: ScrapedList[];
  /*
    EVERY JSON-LD node on the page, `@graph` members flattened, with NO type
    filter. A portfolio contributes its Person node, a shop page its Product
    node, a recipe its Recipe node.

    This is what survives the old person extractor, and it comes out strictly
    wider than it went in: the dispatch dies and the reading generalises to
    every page rather than only to the one the dispatch selected.
  */
  structuredData: Record<string, unknown>[];
  imageCandidates: ImageCandidate[];
  /*
    True when the budget dropped anything. Rides all the way out.
  */
  isTruncated: boolean;
}
