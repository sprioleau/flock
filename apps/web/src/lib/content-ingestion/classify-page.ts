import { z } from "zod";
import type { ImageCandidate, PageScrape } from "./page-scrape";

/**
 * Read a scraped page and say what it is, how much that reading can be
 * trusted, and which of its images are worth keeping.
 *
 * THE CONSTRAINT THIS MODULE EXISTS TO SATISFY: the classifier never sees the
 * user's message. Not "is told to ignore it" — it is not passed.
 * `buildClassificationPrompt` takes a `PageScrape` and nothing else, so there
 * is no parameter through which a phrasing could arrive. That is a property of
 * the signature rather than of anyone's discipline, and widening it is the one
 * change to this file that should never be made quietly.
 *
 * THE OTHER RULE: `pageType` is an OUTPUT. Nothing downstream may branch on
 * it. The one exception is named honestly in the confidence handling below —
 * a low-confidence reading STOPS, and that stop is a behaviour change driven
 * by the reading rather than by the label.
 */

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/*
  Nine values. The discipline that produced them: no label enters the set
  unless something behaves differently because of it. A label that changes
  nothing is decoration that costs tokens and invites a wrong answer.

  Closed in the schema (structured output wants an enum, and an open string
  field produces a long tail of near-synonyms nobody can act on) but
  NON-EXHAUSTIVE in effect, because nothing looks the label up in a table. A
  recipe, a conference agenda, or a README lands on `reference` or `other` and
  is still read, still summarised, still has its images assigned.
*/
export const PAGE_TYPES = [
  "person_profile",
  "portfolio",
  "article",
  "product",
  "organization",
  "event",
  "collection",
  "reference",
  "other",
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type PageConfidence = (typeof PAGE_CONFIDENCE_LEVELS)[number];

export const IMAGE_ROLES = ["portrait", "logo", "lead", "supporting"] as const;
export type ImageRole = (typeof IMAGE_ROLES)[number];

export interface ImageAssignment {
  candidateId: string;
  role: ImageRole;
  subject?: string;
}

export interface PageClassification {
  pageType: PageType;
  /** Required when pageType is "other" — what the page actually is. */
  pageTypeNote?: string;
  confidence: PageConfidence;
  /** Required when confidence is "medium" — the one thing that is unclear. */
  uncertaintyNote?: string;
  /** The reader's own account of the page, so a human can tell if the right page was read. */
  sourceSummary: string;
  /** False when there is not enough here to build an honest email from. */
  isPlanUsable: boolean;
  /** What to tell the user when isPlanUsable is false. */
  message?: string;
  images: ImageAssignment[];
  /**
   * A subject whose public record would add something. Consumed only when web
   * search is switched on; absent is the normal case.
   */
  searchSubject?: string;
}

// ---------------------------------------------------------------------------
// The model-facing schema
// ---------------------------------------------------------------------------

export const pageClassificationSchema = z.object({
  pageType: z.enum(PAGE_TYPES),
  pageTypeNote: z.string().max(200).optional(),
  confidence: z.enum(PAGE_CONFIDENCE_LEVELS),
  uncertaintyNote: z.string().max(600).optional(),
  sourceSummary: z.string().max(400),
  isPlanUsable: z.boolean(),
  message: z.string().max(600).optional(),
  images: z
    .array(
      z.object({
        candidateId: z.string().max(40),
        role: z.enum(IMAGE_ROLES),
        subject: z.string().max(120).optional(),
      }),
    )
    .max(12),
  searchSubject: z.string().max(120).optional(),
});

// ---------------------------------------------------------------------------
// Rendering the page for the reader
// ---------------------------------------------------------------------------

function renderStructuredData(nodes: Record<string, unknown>[]): string {
  if (nodes.length === 0) {
    return "STRUCTURED DATA:\n  (none — this page declares nothing about itself)";
  }
  const lines = nodes.map((node) => `  ${JSON.stringify(node)}`);
  return `STRUCTURED DATA:\n${lines.join("\n")}`;
}

function renderImage(candidate: ImageCandidate): string {
  const parts = [
    `  ${candidate.id}`,
    `origin=${candidate.origin}`,
    candidate.alt === undefined ? undefined : `alt=${JSON.stringify(candidate.alt)}`,
    candidate.width === undefined || candidate.height === undefined
      ? undefined
      : `size=${candidate.width}x${candidate.height}`,
    `order=${candidate.documentOrder}`,
    candidate.hints.length === 0 ? undefined : `hints=[${candidate.hints.join(", ")}]`,
    candidate.nearestHeading === undefined
      ? undefined
      : `near=${JSON.stringify(candidate.nearestHeading)}`,
  ];
  return parts.filter((part) => part !== undefined).join("  ");
}

/**
 * Render one scraped page for the reader.
 *
 * ONE PARAMETER. See the module header: this signature is the guarantee that
 * no user phrasing can reach the classifier, and it is asserted by a test that
 * exists specifically to fail if someone widens it.
 */
export function buildClassificationPrompt(scrape: PageScrape): string {
  const contentLines: string[] = [];
  let index = 0;
  for (const block of scrape.blocks) {
    const label = block.kind === "heading" ? "H " : "P ";
    contentLines.push(`  [${index}] ${label} ${block.text}`);
    index += 1;
  }
  for (const list of scrape.lists) {
    const heading =
      list.headingBefore === undefined ? "" : ` (under ${JSON.stringify(list.headingBefore)})`;
    contentLines.push(
      `  [${index}] LIST[${list.linkDensity.toFixed(2)}]${heading}  ${list.items.join(" · ")}`,
    );
    index += 1;
  }

  const images =
    scrape.imageCandidates.length === 0
      ? "IMAGES:\n  (none)"
      : `IMAGES:\n${scrape.imageCandidates.map(renderImage).join("\n")}`;

  return `${CLASSIFICATION_INSTRUCTIONS}

────────────────────── THE PAGE ──────────────────────
URL: ${scrape.finalUrl}
CANONICAL: ${scrape.canonicalUrl}
SITE: ${scrape.siteName}
TITLE: ${scrape.title}
DESCRIPTION: ${scrape.description ?? "(none)"}
${renderStructuredData(scrape.structuredData)}
CONTENT:
${contentLines.length === 0 ? "  (none)" : contentLines.join("\n")}
${images}
${scrape.isTruncated ? "\n(This page was long. Trailing content was cut.)" : ""}`;
}

// ---------------------------------------------------------------------------
// The instructions
// ---------------------------------------------------------------------------

/*
  Nothing in this text is a user phrasing. There is no "my portfolio", no
  "about me", no keyword list; the word "user" does not appear. The four
  worked examples are fully synthetic — invented people, invented businesses,
  .example domains — so the reader cannot pattern-match a real brand, and none
  of the owner's own site, content, or wording appears anywhere.

  Two things in here are set by MEASUREMENT against ten real pages rather than
  by reasoning, and both should survive edits:

  1. Structured data is present on 4 of 10 real pages and USEFULLY typed on 3.
     The page that most obviously was an event declared no Event node at all.
     So it is described as corroboration, never as the thing to wait for.

  2. width/height are absent entirely on 5 of 10 pages — including a faculty
     bio, a docs page, and a README. So the portrait reasoning leads with alt
     text and document position, and treats size as corroborating. An
     example's stated rationale is the part a reader imitates hardest, and
     leading with a signal that is missing half the time teaches it to look
     for something that is usually not there.
*/
const CLASSIFICATION_INSTRUCTIONS = `You are given ONE web page that has already been fetched and read. Everything below the line is what was on that page. Your job is to say what kind of page it is, how much you trust that reading, and which of its images are worth keeping.

You are not given, and must not ask for, anything about who requested this or why. Decide from the page.

## What to return

pageType — one of:
  person_profile   a page about one person as a person: an about page, a staff
                   bio, a faculty page
  portfolio        someone's body of work: their identity AND what they made
  article          one written piece about a topic: a post, a news story, an
                   essay, release notes
  product          one thing you can buy or sign up for
  organization     a company, team, or project's own page
  event            something happening at a time and place
  collection       an index of many items: a blog index, a shop category, a
                   list of links
  reference        instructions and specifics: documentation, a spec sheet, a
                   how-to
  other            none of the above fits. Say what it is in pageTypeNote.

Many real pages sit between two of these. Pick the one that best describes what the page is FOR, lower your confidence, and say what the other reading was in uncertaintyNote. Never stretch a page to fit a label; "other" with a clear note is a better answer than a confident wrong label.

confidence — how much you would trust an email built from this page, not how sure you are of the label:
  high    the page says plainly what it is and there is enough on it to work from
  medium  you can build something honest, but one thing is unclear or thin.
          uncertaintyNote is REQUIRED and must name that one thing.
  low     you cannot build an honest email from this page. Set
          isPlanUsable: false and say in message what you found and what was
          missing. Deciding there is not enough here is a correct answer, and
          often the most useful one.

sourceSummary — up to 400 characters, in your own words: what this page is and what is on it. Someone who has not seen the page should be able to tell from this whether the right page was read.

images — role assignments for the candidates listed on the page. Refer to a candidate by its id. You cannot write an image address and must not try; an id that is not in the list is discarded.

  role  portrait     a photograph of one person, as a person
        logo         a mark identifying an organization
        lead         the page's own main image
        supporting   anything else worth showing

  At most four images are kept, in that order of priority. Assign a role only when the candidate's alt text, its position, the copy around it, or its size actually supports it. Leaving a candidate unassigned is a normal outcome — chrome, icons, and decoration should get no role at all.

searchSubject — OPTIONAL, and usually absent. Set it only when the page names a specific person or organization whose public record would genuinely add something an email needs. Say the subject in your own words.

## How to read the page

- The CONTENT lines are in page order. Order is evidence: paragraphs following a heading belong to it.
- LIST lines show their link density in brackets. A list at 0.00 is content the page wrote. A list near 1.00 is navigation. A list is often the most concrete thing on a page.
- STRUCTURED DATA is what the page's own publisher declared about itself. When it is there and disagrees with the prose, prefer it for names, titles, prices, and dates. Most pages declare nothing at all, so treat it as corroboration when present and never wait for it.
- Judge an image mainly by its alt text and where it sits in the document. Sizes are often missing entirely; when they are present they corroborate, and when they are absent that tells you nothing either way.

## Worked examples

These four pages are made up, and they are deliberately unalike. Read them for HOW the evidence decides the answer — not for the answers themselves. They reach four different page types, three different confidence levels, and very different image outcomes, BECAUSE the pages differ. Do not carry a page type, a confidence level, or an image assignment from an example onto the page in front of you. If your answer looks like one of these and the page does not, you have copied instead of read.

────────────────────── EXAMPLE A ──────────────────────
URL: https://marisol-okonkwo.example/
SITE: Marisol Okonkwo
TITLE: Marisol Okonkwo — Photography
DESCRIPTION: Harbour and dockside photography from the north Atlantic coast.
STRUCTURED DATA:
  {"@type":"Person","name":"Marisol Okonkwo","jobTitle":"Photographer"}
CONTENT:
  [0] H  Marisol Okonkwo
  [1] P  I photograph working harbours — the boats, the cranes, and the people who keep them running. Fifteen years, mostly before sunrise.
  [2] H  What I shoot
  [3] P  "Cold Water", a two-year series following one trawler crew through four seasons, showed at the Fenwick Maritime Museum last spring.
  [4] LIST[0.00] (under "What I shoot")  Harbour and dockside · Working portraits · Long-exposure night work · Editorial assignments
IMAGES:
  img_1  origin=inline  alt="Marisol Okonkwo"  order=0  hints=[portrait-ish, square]  near="Marisol Okonkwo"
  img_2  origin=og-image  alt="Trawler at dawn"  order=1
  img_3  origin=inline  alt="Crew hauling nets"  order=2
  img_4  origin=inline  alt="Crane at night"  order=3

→ {
    "pageType": "portfolio",
    "confidence": "high",
    "isPlanUsable": true,
    "sourceSummary": "Marisol Okonkwo's own photography site. It gives her name and trade, a first-person paragraph about fifteen years shooting working harbours, a four-item list of what she shoots, and a note about a two-year series called Cold Water that showed at a maritime museum. Four images: a portrait and three harbour shots.",
    "images": [
      { "candidateId": "img_1", "role": "portrait", "subject": "Marisol Okonkwo" },
      { "candidateId": "img_2", "role": "lead" },
      { "candidateId": "img_3", "role": "supporting" },
      { "candidateId": "img_4", "role": "supporting" }
    ]
  }

Why portfolio and not person_profile: the page is her identity AND her work, and the work is most of it. Why img_1 is the portrait: it is first in the document, its alt text is exactly her name, and the copy beside it introduces her — the square shape agrees, and would not have been enough on its own.

────────────────────── EXAMPLE B ──────────────────────
URL: https://ashgrove-toolworks.example/planes/no-4-smoother
SITE: Ashgrove Toolworks
TITLE: The No. 4 Smoothing Plane
STRUCTURED DATA:
  (none — this page declares nothing about itself)
CONTENT:
  [0] H  The No. 4 Smoothing Plane
  [1] P  Ductile iron body, bronze lever cap, and an O1 tool-steel iron ground at 25 degrees. Made in Ashgrove, forty a year.
  [2] P  £285. Twelve-week lead time; we will write when yours is on the bench.
  [3] LIST[0.00]  Sole 245mm · Iron 51mm, 4mm thick · Weight 1.9kg · Bronze and ductile iron · Twelve-week lead time
IMAGES:
  img_1  origin=og-image  alt="No. 4 smoothing plane, three-quarter view"  order=0

→ {
    "pageType": "product",
    "confidence": "high",
    "isPlanUsable": true,
    "sourceSummary": "A product page from Ashgrove Toolworks for a single hand plane: its materials, a five-item spec list, a £285 price, and a twelve-week lead time. One product photograph.",
    "images": [ { "candidateId": "img_1", "role": "lead" } ]
  }

This page declares no structured data at all, which is the ordinary case and changes nothing — the price and the specs are in the prose and the list, and that is enough. One image, and it is the product, so it is the lead. There is nobody on this page, so there is no portrait; not assigning one is the answer, not an omission.

────────────────────── EXAMPLE C ──────────────────────
URL: https://wrenfield-garden.example/sowing-season
SITE: Wrenfield Community Garden
TITLE: Sowing Season
STRUCTURED DATA:
  (none — this page declares nothing about itself)
CONTENT:
  [0] H  Sowing Season
  [1] P  Six Saturday mornings between February and April, in the polytunnel and the top beds. Bring gloves; we have everything else.
  [2] P  Free to members, £4 otherwise. Sign up on the board by the gate or email the address below.
  [3] LIST[0.04]  8 Feb — Seed saving · 22 Feb — Potting on · 8 Mar — Bare-root fruit · 22 Mar — Comfrey and nettle feeds · 5 Apr — Hardening off · 19 Apr — Companion planting
IMAGES:
  img_1  origin=inline  alt="Seedlings in the polytunnel"  order=0

→ {
    "pageType": "event",
    "confidence": "medium",
    "isPlanUsable": true,
    "uncertaintyNote": "This reads as one running series rather than one event — six dated sessions, no single time or venue beyond 'the polytunnel', and no booking link anywhere on the page. It could equally be read as a listing of six separate events.",
    "sourceSummary": "Wrenfield Community Garden's page for a spring series: six Saturday-morning sessions between February and April, each with a date and a topic, free to members and £4 otherwise, signed up for on a noticeboard or by email. One photograph of seedlings.",
    "images": [ { "candidateId": "img_1", "role": "lead" } ]
  }

This page does not sit cleanly in the list, and that is normal rather than a failure: pick the nearest label, drop to medium, say exactly what the other reading was, and carry on. Note what did NOT happen — nothing was invented to make the page fit "event". There is no venue line on the page, so there is no venue line in the summary.

────────────────────── EXAMPLE D ──────────────────────
URL: https://fenwick-library.example/resources
SITE: Fenwick Library
TITLE: Resources
STRUCTURED DATA:
  (none — this page declares nothing about itself)
CONTENT:
  [0] H  Resources
  [1] P  Things we have found useful. Suggestions welcome at the front desk.
  [2] LIST[0.96]  Archive catalogue · Local newspapers 1840–1974 · Parish records · Ordnance Survey sheets · Ships' registers · … (37 more)
IMAGES:
  (none)

→ {
    "pageType": "collection",
    "confidence": "low",
    "isPlanUsable": false,
    "uncertaintyNote": "There is nothing on this page to write an email about.",
    "sourceSummary": "A links page at Fenwick Library: one sentence of introduction and a list of forty-two links to other resources. No copy about any of them and no images.",
    "message": "That page is an index — one line of introduction and forty-two links, with nothing written about any of them. There is not enough on it to build an email from. If one of the things it links to is what you had in mind, point me at that page instead.",
    "images": []
  }

Deciding there is not enough here is a correct answer, and this is what it looks like. The list is at link density 0.96, which means it is navigation rather than content — building an email out of forty link labels would have produced something that says nothing, which is worse than saying so.`;

// ---------------------------------------------------------------------------
// Validation — deterministic, pure, and never trusting
// ---------------------------------------------------------------------------

/**
 * Reconcile what the reader said against what is actually on the page.
 *
 * Everything here is a rule about COHERENCE, not about page kind. An answer
 * naming an image the page does not have, or claiming high confidence while
 * refusing to build, is incoherent whatever kind of page it read.
 */
export function validateClassification({
  classification,
  scrape,
}: {
  classification: PageClassification;
  scrape: PageScrape;
}): PageClassification {
  const knownIds = new Set(scrape.imageCandidates.map((candidate) => candidate.id));

  /*
    An assignment naming an id the page never offered is dropped silently and
    BEFORE any network call. This is the structural half of "the model cannot
    supply an image": it emits ids, and an id that is not on the list buys it
    nothing.
  */
  const seenIds = new Set<string>();
  const images = classification.images.filter((assignment) => {
    if (!knownIds.has(assignment.candidateId) || seenIds.has(assignment.candidateId)) {
      return false;
    }
    seenIds.add(assignment.candidateId);
    return true;
  });

  let { confidence, isPlanUsable } = classification;

  /*
    ORDER MATTERS HERE, and getting it wrong is subtle enough to be worth
    stating: these rules must not be able to undo one another.

    The note rule reads the model's OWN answer and runs FIRST. Run last, it
    would look at a `medium` that rule 3 had just produced, find no note
    attached to it, and promote it straight back to `high` — quietly
    reinstating the exact incoherent answer rule 3 exists to remove.
  */

  /* 1. A "medium" with nothing to say is really a "high". The agent is
        expected to relay the note, so a medium without one says nothing. */
  if (confidence === "medium" && (classification.uncertaintyNote ?? "").trim().length === 0) {
    confidence = "high";
  }

  /* 2. Low confidence means STOP, whatever else came back. This is the one
        place a reading changes behaviour rather than shape, and it is the
        reason for asking about confidence at all. */
  if (confidence === "low") {
    isPlanUsable = false;
  }

  /* 3. "I am completely sure, and also there is nothing here" is incoherent.
        The confidence is what gives way — a refusal we trust less is still a
        refusal, whereas downgrading the refusal instead would build from a
        page the reader just said it could not use. */
  if (!isPlanUsable && confidence === "high") {
    confidence = "medium";
  }

  return {
    ...classification,
    confidence,
    isPlanUsable,
    images,
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * The classifier's ONLY model dependency. Production passes a generateObject
 * wrapper; tests pass a function returning a canned object, or one that
 * throws. That makes the prompt, the validation, the floor, and everything
 * downstream exercisable without a live call — which matters because the free
 * tier is shared with production.
 */
export type ClassifyFn = (input: { prompt: string }) => Promise<unknown>;

/**
 * What comes back when the reading could not happen at all — a timeout, an
 * exhausted quota, a schema the model did not satisfy, or a run with no model
 * behind it.
 *
 * It is a SUCCESSFUL, usable answer, not an error. The page was fetched and
 * read; only the interpretation is missing. So the floor keeps everything the
 * scrape already knows and simply declines to claim more, and it says the
 * reading was shallow rather than pretending otherwise.
 */
/*
  Origins that may stand in as a lead when nothing read the page, best first.
  A preference over EVIDENCE — where the publisher put the image — not over
  subject matter, which is precisely what is unavailable here. `link-icon` is
  absent on purpose: a favicon is never a lead image.
*/
const FLOOR_LEAD_ORIGINS = ["og-image", "structured-data", "inline"] as const;

/*
  Hints that disqualify a candidate at any origin. A page nominating a 32x32
  glyph as its og:image has nominated a favicon by another route.
*/
const NON_LEAD_HINTS = ["icon-ish", "small"];

function selectFloorLeadImage(candidates: ImageCandidate[]): ImageAssignment[] {
  for (const origin of FLOOR_LEAD_ORIGINS) {
    const found = candidates.find(
      (candidate) =>
        candidate.origin === origin &&
        !candidate.hints.some((hint) => NON_LEAD_HINTS.includes(hint)),
    );
    if (found !== undefined) {
      return [{ candidateId: found.id, role: "lead" }];
    }
  }
  return [];
}

export function buildDeterministicFloor(scrape: PageScrape): PageClassification {
  return {
    pageType: "other",
    pageTypeNote: "Not classified — the page was read but not interpreted.",
    confidence: "low",
    isPlanUsable: false,
    sourceSummary: [scrape.title, scrape.siteName, scrape.description]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" — ")
      .slice(0, 400),
    message:
      "I could read that page, but I couldn't make sense of it well enough to build from it confidently. Tell me what you want the email to say and I'll work from the page's own words.",
    /*
      The floor still keeps ONE image, and that is deliberate: a refusal the
      user cannot cheaply recover from just makes them re-ask, and we pay for
      the fetch again. The publisher's own nominated image plus the title and
      description is enough for the agent to say what it found and ask what
      they meant, without a second round trip.
    */
    images: selectFloorLeadImage(scrape.imageCandidates),
  };
}

/**
 * Classify one scraped page. Never throws.
 *
 * A page that was fetched successfully always produces a usable answer — the
 * floor when the reading fails. Throwing here would put a page we DID read
 * onto the error path, where the model is invited to retry a call that will
 * fail the same way and cost the same quota.
 */
export async function classifyPage({
  scrape,
  classify,
}: {
  scrape: PageScrape;
  classify: ClassifyFn | null;
}): Promise<PageClassification> {
  if (classify === null) {
    return buildDeterministicFloor(scrape);
  }
  try {
    const raw = await classify({ prompt: buildClassificationPrompt(scrape) });
    const parsed = pageClassificationSchema.safeParse(raw);
    if (!parsed.success) {
      return buildDeterministicFloor(scrape);
    }
    return validateClassification({ classification: parsed.data, scrape });
  } catch {
    return buildDeterministicFloor(scrape);
  }
}
