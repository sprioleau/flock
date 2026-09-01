import {
  SECTION_TEMPLATES,
  getModelFacingParamsSchema,
  getSectionTemplate,
} from "@flock/email-sdk";
import { z } from "zod";
import type { ImageCandidate, PageScrape } from "./page-scrape";

/*
  Read a scraped page and say what it is, how much that reading can be
  trusted, and which of its images are worth keeping.

  THE CONSTRAINT THIS MODULE EXISTS TO SATISFY: the classifier never sees the
  user's message. Not "is told to ignore it" — it is not passed.
  `buildClassificationPrompt` takes a `PageScrape` and nothing else, so there
  is no parameter through which a phrasing could arrive. That is a property of
  the signature rather than of anyone's discipline, and widening it is the one
  change to this file that should never be made quietly.

  THE OTHER RULE: `pageType` is an OUTPUT. Nothing downstream may branch on
  it. The one exception is named honestly in the confidence handling below —
  a low-confidence reading STOPS, and that stop is a behaviour change driven
  by the reading rather than by the label.
*/

/*
  ---------------------------------------------------------------------------
  The vocabulary
  ---------------------------------------------------------------------------
*/

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

/*
  One email section the page's own content would make.

  `params` is deliberately loose. The catalog's own schemas fill every field
  they were not given, so a param the reader misnames falls back to the
  template's SAMPLE copy — which is the original defect wearing a better
  payload. `validateSections` reports those, so the failure is at least
  visible rather than silent.
*/
export interface MappedSection {
  templateId: string;
  params: Record<string, unknown>;
  /*
    Which numbered CONTENT lines this section's copy came from.

    The faithfulness mitigation, and an honest one: it makes fabrication
    VISIBLE, not impossible. A determined confabulation can cite block 3 and
    write something block 3 does not say. What it does buy is that a section
    imitated from a worked example has nothing on the page to point at — so
    the commonest failure mode of an example-steered prompt is catchable.
  */
  sourceBlockIndices: number[];
  /*
    One short line: what on the page this section is.
  */
  rationale: string;
}

export interface PageClassification {
  pageType: PageType;
  /*
    Required when pageType is "other" — what the page actually is.
  */
  pageTypeNote?: string;
  confidence: PageConfidence;
  /*
    Required when confidence is "medium" — the one thing that is unclear.
  */
  uncertaintyNote?: string;
  /*
    The reader's own account of the page, so a human can tell if the right page was read.
  */
  sourceSummary: string;
  /*
    False when there is not enough here to build an honest email from.
  */
  isPlanUsable: boolean;
  /*
    What to tell the user when isPlanUsable is false.
  */
  message?: string;
  images: ImageAssignment[];
  /*
    The email this page's content would make, in reading order.
  */
  sections: MappedSection[];
  /*
    A subject whose public record would add something. Consumed only when web
    search is switched on; absent is the normal case.
  */
  searchSubject?: string;
}

/*
  ---------------------------------------------------------------------------
  The model-facing schema
  ---------------------------------------------------------------------------
*/

/*
  GENEROUS BOUNDS, CLAMPED LATER — and the reason is measured, not theoretical.

  These fields were bounded at the sizes the prompt asks for (400 characters of
  summary, and so on). On a real page the reader produced a genuinely good
  four-section plan and a summary of about 430 characters, and zod rejected the
  WHOLE object for the overage. The pipeline then fell to its floor and the
  user got nothing — a perfect plan discarded over thirty characters of prose.

  A length the model overshoots slightly is a formatting problem, not a
  correctness one. So the schema stays permissive enough to accept the answer
  and `clampText` trims it afterwards. The prompt still states the real limits,
  because asking for the right size is what usually gets it.
*/
const GENEROUS = 8_000;

/*
  ONE flat copy vocabulary, with every field named explicitly, rather than the
  per-template param object it might look like this should be.

  MEASURED, and the measurement is the whole reason for this shape. An earlier
  version asked for `params` as an open object (`z.looseObject({})`), which
  renders to JSON Schema as:

      { "type": "object", "properties": {}, "additionalProperties": {} }

  Gemini's constrained decoding CANNOT emit a key that is not declared as a
  property, so it returned `params: {}` for every section of every page —
  while getting the templateId, the rationale, and the cited lines right. The
  sections were therefore perfect and completely empty, and each one would have
  rendered its template's SAMPLE copy. An email that looks built from the
  user's site and says nothing about it is precisely the defect this whole
  pipeline exists to remove, so a silent version of it is the worst possible
  outcome. Side-by-side against an explicit-property schema on the same page,
  the explicit one returned real copy immediately.

  Naming every field is therefore not a workaround — it is the only shape that
  works with this provider. It also follows the house principle already stated
  in scaffold-section.ts: model-facing surfaces take SIMPLE intent-level args,
  and all the complexity lives behind a deterministic translation. The
  translation is `toTemplateParams` below.

  This vocabulary maps over PARAM NAMES, never over page kinds. Nothing here
  reads pageType, and the fork does not grow back through it.
*/
const sectionCopySchema = z.object({
  /*
    headline and body are REQUIRED, and that is a measured decision.

    With both optional, Gemini's constrained decoding did what constrained
    decoding does with optional fields: it emitted the minimum. Real plans came
    back carrying a headline and an imageAlt and nothing else — so every
    section would have rendered its template's SAMPLE body ("Everything you
    asked for, in one update…") inside an email the user believed was written
    from their page. Optional fields the model declines to fill are how stock
    copy gets shipped silently.

    Requiring them costs a wasted sentence on the two or three templates that
    have nowhere to put a body; that is a much better trade than a confident
    email of sample text. Templates without a body simply do not read it.
  */
  headline: z.string().max(GENEROUS),
  body: z.string().max(GENEROUS),
  ctaLabel: z.string().max(GENEROUS).optional(),
  ctaHref: z.string().max(GENEROUS).optional(),
  imageAlt: z.string().max(GENEROUS).optional(),
  /*
    Repeated content: feature lists and columns, stats, plan features.
  */
  items: z
    .array(z.object({ title: z.string().max(GENEROUS), body: z.string().max(GENEROUS).optional() }))
    .max(6)
    .optional(),
  /*
    One alt text per gallery image, in order.
  */
  imageAlts: z.array(z.string().max(GENEROUS)).max(6).optional(),
  /*
    A single purchasable thing.
  */
  name: z.string().max(GENEROUS).optional(),
  description: z.string().max(GENEROUS).optional(),
  price: z.string().max(GENEROUS).optional(),
  /*
    Somebody quoted.
  */
  quote: z.string().max(GENEROUS).optional(),
  attribution: z.string().max(GENEROUS).optional(),
  role: z.string().max(GENEROUS).optional(),
  /*
    A code sample.
  */
  code: z.string().max(GENEROUS).optional(),
  language: z.string().max(GENEROUS).optional(),
});

export type SectionCopy = z.infer<typeof sectionCopySchema>;

/*
  Which catalog param each vocabulary field becomes, per template. A table over
  NAMES — there is no page type in it, and nothing branches on one.

  Only body-section templates appear: headers and footers are added
  automatically downstream, and the prompt tells the reader not to plan them.
*/
/*
  Copy fields that make a section worth rendering. Alt text alone does not:
  a section carrying only an image description would render every OTHER field
  from the template's sample copy, which is the failure this pipeline exists to
  remove.
*/
const SUBSTANTIVE_COPY_FIELDS: readonly (keyof SectionCopy)[] = [
  "headline",
  "body",
  "items",
  "imageAlts",
  "name",
  "description",
  "quote",
  "code",
];

export function getHasSubstantiveCopy(copy: SectionCopy): boolean {
  return SUBSTANTIVE_COPY_FIELDS.some((field) => {
    const value = copy[field];
    return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0;
  });
}

function toTemplateParams({
  templateId,
  copy,
  pageUrl,
}: {
  templateId: string;
  copy: SectionCopy;
  pageUrl: string;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) {
      params[key] = value;
    }
  };
  /*
    A button's destination, and never an invented one. The reader is told to
    use an address that is on the page; when it gives none, the page's own
    address stands in.

    Leaving it out is no longer a broken button — a template whose ctaHref
    nobody supplied now renders no button at all rather than one pointing at
    example.com. It is still the worse answer here: this pipeline is reading a
    real page, so it always has one honest destination to offer, and a hero
    with a label and nowhere to go would be dropped to no button over a detail
    we know. Falling back to the page they pointed at keeps the button and
    keeps it true.
  */
  const ctaHref = copy.ctaHref ?? pageUrl;

  switch (templateId) {
    case "hero":
    case "hero-split":
      put("headline", copy.headline);
      put("body", copy.body);
      put("imageAlt", copy.imageAlt);
      put("ctaLabel", copy.ctaLabel);
      put("ctaHref", ctaHref);
      break;
    case "article":
      put("headline", copy.headline);
      put("body", copy.body);
      put("imageAlt", copy.imageAlt);
      break;
    case "cta":
      put("headline", copy.headline);
      put("body", copy.body);
      put("ctaLabel", copy.ctaLabel);
      put("ctaHref", ctaHref);
      break;
    case "feature-list":
    case "feature-columns":
      put("headline", copy.headline);
      put(
        "features",
        copy.items?.map((item) => ({ title: item.title, body: item.body ?? item.title })),
      );
      break;
    case "stats":
      put("headline", copy.headline);
      /*
        stats take value/label, not title/body — the same content, renamed.
      */
      put(
        "stats",
        copy.items?.map((item) => ({ value: item.title, label: item.body ?? item.title })),
      );
      break;
    case "image-gallery":
      put("images", copy.imageAlts?.map((alt) => ({ alt })));
      break;
    case "product":
      put("name", copy.name ?? copy.headline);
      put("description", copy.description ?? copy.body);
      put("price", copy.price);
      put("imageAlt", copy.imageAlt);
      put("ctaLabel", copy.ctaLabel);
      put("ctaHref", ctaHref);
      break;
    case "pricing":
      put("planName", copy.name ?? copy.headline);
      put("price", copy.price);
      /*
        pricing features are bare strings, not objects.
      */
      put("features", copy.items?.map((item) => item.title));
      put("ctaLabel", copy.ctaLabel);
      put("ctaHref", ctaHref);
      break;
    case "testimonial":
      put("quote", copy.quote ?? copy.body);
      put("attribution", copy.attribution);
      put("role", copy.role);
      break;
    case "testimonial-columns":
      put(
        "testimonials",
        copy.items?.map((item) => ({ quote: item.body ?? item.title, attribution: item.title })),
      );
      break;
    case "code-sample":
      put("headline", copy.headline);
      put("body", copy.body);
      put("code", copy.code);
      put("language", copy.language);
      break;
    default:
      break;
  }
  return params;
}



export const pageClassificationSchema = z.object({
  pageType: z.enum(PAGE_TYPES),
  pageTypeNote: z.string().max(GENEROUS).optional(),
  confidence: z.enum(PAGE_CONFIDENCE_LEVELS),
  uncertaintyNote: z.string().max(GENEROUS).optional(),
  sourceSummary: z.string().max(GENEROUS),
  isPlanUsable: z.boolean(),
  message: z.string().max(GENEROUS).optional(),
  images: z
    .array(
      z.object({
        candidateId: z.string().max(40),
        role: z.enum(IMAGE_ROLES),
        subject: z.string().max(GENEROUS).optional(),
      }),
    )
    .max(12),
  sections: z
    .array(
      z.object({
        templateId: z.string().max(60),
        copy: sectionCopySchema,
        sourceBlockIndices: z.array(z.number().int().min(0)).max(20),
        rationale: z.string().max(GENEROUS),
      }),
    )
    /*
      16, aligned with MAX_DRAFT_PLAN_SECTIONS in @flock/email-sdk — this plan
      maps one-to-one onto createDraft's sections (header + body + footer), so
      the two caps must agree or a rich plan is rejected downstream. 10 was a
      silent content ceiling: a page with a dozen real items could never be
      planned in full, however faithfully the model tried.
    */
    .max(16),
  searchSubject: z.string().max(GENEROUS).optional(),
});

/*
  ---------------------------------------------------------------------------
  Rendering the page for the reader
  ---------------------------------------------------------------------------
*/

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

/*
  Render one scraped page for the reader.

  ONE PARAMETER. See the module header: this signature is the guarantee that
  no user phrasing can reach the classifier, and it is asserted by a test that
  exists specifically to fail if someone widens it.
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

  return `${buildClassificationInstructions()}

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

/*
  ---------------------------------------------------------------------------
  The instructions
  ---------------------------------------------------------------------------
*/

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
function buildClassificationInstructions(): string {
  return `You are given ONE web page that has already been fetched and read. Everything below the line is what was on that page. Your job is to say what kind of page it is, how much you trust that reading, and which of its images are worth keeping.

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

sections — the email this page's own content would make, in reading order. Each one is a catalog template id plus its content params, written from what the page actually says.

  templateId          from the catalog at the end of these instructions
  copy                the words this section should say, drawn from the page.
                      Fill only the fields that template needs — the catalog
                      listing names them — and leave the rest out.
  sourceBlockIndices  which numbered CONTENT lines this section's copy came
                      from. EVERY section must cite at least one. A section
                      you cannot point at a line for does not belong.
  rationale           one short line: what on the page this section is

  The copy fields, and what each is for:
    headline     the section's heading
    body         one or two sentences under it
    ctaLabel     a button's visible words
    ctaHref      where that button goes. Use a URL that is ON the page, or the
                 page's own address. Never invent one.
    imageAlt     alt text for this section's image
    items        repeated content: a feature list, a set of statistics, a plan's
                 features. Each has a title and an optional body.
    imageAlts    one alt text per gallery image, in order
    name         what a single purchasable thing is called
    description  what that thing is
    price        what it costs, as the page writes it
    quote        somebody's exact words
    attribution  who said them
    role         their title
    code         a code sample
    language     what language it is in

  FILL THE COPY. A section whose copy is empty renders generic sample text and
  says nothing about this page, which is worse than not planning it at all.

  Do NOT include a header or a footer. Those are added for you.

  Write email copy from what the page says. Condense and rephrase freely; do not add a fact, a number, a date, or a name that is not on the page. If the page does not give you something a template wants, leave that param out rather than inventing it — a missing line is always better than an invented one.

  You cannot set any image address. Images are attached for you from the roles you assigned above; write the alt text and nothing else.

searchSubject — OPTIONAL, and usually absent. Set it only when the page names a specific person or organization whose public record would genuinely add something an email needs. Say the subject in your own words.

## How to read the page

- The CONTENT lines are in page order. Order is evidence: paragraphs following a heading belong to it.
- LIST lines show their link density in brackets. A list at 0.00 is content the page wrote. A list near 1.00 is navigation. A list is often the most concrete thing on a page.
- STRUCTURED DATA is what the page's own publisher declared about itself. When it is there and disagrees with the prose, prefer it for names, titles, prices, and dates. Most pages declare nothing at all, so treat it as corroboration when present and never wait for it.
- Judge an image mainly by its alt text and where it sits in the document. Sizes are often missing entirely; when they are present they corroborate, and when they are absent that tells you nothing either way.

## Worked examples

These five pages are made up, and they are deliberately unalike. Read them for HOW the evidence decides the answer — not for the answers themselves. They reach four different page types, three different confidence levels, and very different image outcomes, BECAUSE the pages differ.

They also produce FOUR, TWO, THREE, ZERO, and FIVE sections, in different orders, sharing almost no templates. That is not decoration: the number and shape of an email come from what the page has. A page with two things to say makes a two-section email — and, just as much, a page with a dozen distinct things to say (a run of events, products, people, posts, or listings) makes a long, many-section email: plan one faithful section per distinct item, up to the ceiling, rather than collapsing them into a generic two-or-three-section summary. This cuts both ways — match the page's real length, neither padding a sparse page nor starving a rich one. When a list is genuinely long, cover a representative, recent sample and summarize the tail in prose rather than naming every item. Do not carry a section count, a section order, or a template choice from an example onto the page in front of you. If your plan looks like one of these and the page does not, you have copied instead of read — and every section must cite a line on THIS page, so a copied one has nothing to point at.

EVERY repeated-content template — feature-list, feature-columns, testimonial-columns, stats, pricing's features, a gallery's images — holds only a handful of entries (two to six, depending on the template; the catalog listing below says which). That cap is a page-design limit, not a reading of how much the source page has to say, so when the page repeats more distinct things than ONE section of that template can hold, use a SECOND section of the same template for the next batch — do not let the template's own ceiling become the plan's ceiling. Example E below shows exactly this: eight talks, two feature-list sections of four apiece, because one list only goes to five.

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
    ],
    "sections": [
      { "templateId": "hero-split",
        "copy": {
          "headline": "Marisol Okonkwo",
          "body": "Photographer. Fifteen years of working harbours — the boats, the cranes, and the people who keep them running, mostly before sunrise.",
          "imageAlt": "Marisol Okonkwo" },
        "sourceBlockIndices": [0, 1],
        "rationale": "Her name and the paragraph that says what she does." },
      { "templateId": "feature-list",
        "copy": {
          "headline": "What I shoot",
          "items": [
            { "title": "Harbour and dockside", "body": "Working ports, at work." },
            { "title": "Working portraits", "body": "The people who keep them running." },
            { "title": "Long-exposure night work", "body": "Cranes and water after dark." },
            { "title": "Editorial assignments", "body": "Commissions across the north coast." } ] },
        "sourceBlockIndices": [2, 4],
        "rationale": "The page's own list of specialisms." },
      { "templateId": "image-gallery",
        "copy": {
          "imageAlts": ["Trawler at dawn", "Crew hauling nets", "Crane at night"] },
        "sourceBlockIndices": [3],
        "rationale": "The Cold Water series the page describes." },
      { "templateId": "cta",
        "copy": {
          "headline": "Available for commissions",
          "body": "Across the north coast.",
          "ctaLabel": "Get in touch",
          "ctaHref": "https://marisol-okonkwo.example/" },
        "sourceBlockIndices": [1],
        "rationale": "The availability the page closes on." }
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
    "images": [ { "candidateId": "img_1", "role": "lead" } ],
    "sections": [
      { "templateId": "product",
        "copy": {
          "name": "The No. 4 Smoothing Plane",
          "description": "Ductile iron body, bronze lever cap, and an O1 tool-steel iron ground at 25 degrees. Made in Ashgrove, forty a year.",
          "price": "£285",
          "imageAlt": "No. 4 smoothing plane, three-quarter view",
          "ctaLabel": "See the plane",
          "ctaHref": "https://ashgrove-toolworks.example/planes/no-4-smoother" },
        "sourceBlockIndices": [0, 1, 2],
        "rationale": "The page is one product; this is that product." },
      { "templateId": "feature-list",
        "copy": {
          "items": [
            { "title": "Sole 245mm", "body": "Iron 51mm, 4mm thick." },
            { "title": "1.9kg", "body": "Bronze and ductile iron." },
            { "title": "Twelve-week lead time", "body": "We write when yours is on the bench." } ] },
        "sourceBlockIndices": [3],
        "rationale": "The spec list, condensed to the three that matter in an inbox." }
    ]
  }

Two sections, because two is what the page has. Nothing here wants a gallery and there is nobody to put in a portrait, so neither appears. This page declares no structured data at all, which is the ordinary case and changes nothing — the price and the specs are in the prose and the list, and that is enough. One image, and it is the product, so it is the lead. There is nobody on this page, so there is no portrait; not assigning one is the answer, not an omission.

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
    "images": [ { "candidateId": "img_1", "role": "lead" } ],
    "sections": [
      { "templateId": "hero",
        "copy": {
          "headline": "Sowing Season",
          "body": "Six Saturday mornings between February and April, in the polytunnel and the top beds. Bring gloves; we have everything else.",
          "imageAlt": "Seedlings in the polytunnel" },
        "sourceBlockIndices": [0, 1],
        "rationale": "The page's own opening — what it is and what to bring." },
      { "templateId": "feature-list",
        "copy": {
          "headline": "The six mornings",
          "items": [
            { "title": "8 Feb", "body": "Seed saving." },
            { "title": "22 Feb", "body": "Potting on." },
            { "title": "8 Mar", "body": "Bare-root fruit." },
            { "title": "22 Mar", "body": "Comfrey and nettle feeds." },
            { "title": "5 Apr", "body": "Hardening off." } ] },
        "sourceBlockIndices": [3],
        "rationale": "The dated sessions. The template holds five; the sixth (19 Apr, companion planting) closes the CTA below instead of being silently dropped." },
      { "templateId": "cta",
        "copy": {
          "headline": "Free to members, £4 otherwise",
          "body": "Sign up on the board by the gate — plus a sixth morning on 19 Apr, companion planting.",
          "ctaLabel": "See the season",
          "ctaHref": "https://wrenfield-garden.example/sowing-season" },
        "sourceBlockIndices": [2, 3],
        "rationale": "The page's own instruction, plus the sixth session the list above had no room for. There is no booking link on the page, so the button goes back to the page rather than to an address I would have had to invent." }
    ]
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
    "images": [],
    "sections": []
  }

Deciding there is not enough here is a correct answer, and this is what it looks like. The list is at link density 0.96, which means it is navigation rather than content — building an email out of forty link labels would have produced something that says nothing, which is worse than saying so. An empty plan is a real answer and this is what one looks like.

────────────────────── EXAMPLE E ──────────────────────
URL: https://harrowgate-summit.example/schedule
SITE: Harrowgate Summit
TITLE: 2025 Schedule
STRUCTURED DATA:
  (none — this page declares nothing about itself)
CONTENT:
  [0] H  Harrowgate Summit — 2025 Schedule
  [1] P  One day, eight talks, in the order they run. Doors at nine, first talk at half past.
  [2] H  Morning
  [3] LIST[0.00] (under "Morning")  9:30 — Reading a room before you speak, Priya Nakamura · 10:15 — Debugging in front of people, Femi Osei · 11:00 — What a slide is for, Talia Bergström · 11:45 — Naming things badly on purpose, Rutger Voss
  [4] H  Afternoon
  [5] LIST[0.00] (under "Afternoon")  1:00 — The talk you didn't give, Dov Ashkenazi · 1:45 — Q&A is not the enemy, Priya Nakamura · 2:30 — Shipping on a Friday, Femi Osei · 3:15 — Closing remarks, Talia Bergström
IMAGES:
  img_1  origin=og-image  alt="Harrowgate Summit 2025"  order=0
  img_2  origin=inline  alt="Priya Nakamura speaking"  order=1  near="Morning"

→ {
    "pageType": "event",
    "confidence": "high",
    "isPlanUsable": true,
    "sourceSummary": "Harrowgate Summit's own schedule page for its 2025 conference: a one-day, eight-talk programme run in two halves, morning and afternoon, each talk named with its speaker and time. One event photo and one photo of a speaker.",
    "images": [
      { "candidateId": "img_1", "role": "lead" },
      { "candidateId": "img_2", "role": "supporting", "subject": "Priya Nakamura" }
    ],
    "sections": [
      { "templateId": "hero",
        "copy": {
          "headline": "Harrowgate Summit — 2025 Schedule",
          "body": "One day, eight talks, in the order they run. Doors at nine, first talk at half past.",
          "imageAlt": "Harrowgate Summit 2025" },
        "sourceBlockIndices": [0, 1],
        "rationale": "The page's own opening — what today is and how many talks." },
      { "templateId": "feature-list",
        "copy": {
          "headline": "Morning",
          "items": [
            { "title": "9:30 — Reading a room before you speak", "body": "Priya Nakamura." },
            { "title": "10:15 — Debugging in front of people", "body": "Femi Osei." },
            { "title": "11:00 — What a slide is for", "body": "Talia Bergström." },
            { "title": "11:45 — Naming things badly on purpose", "body": "Rutger Voss." } ] },
        "sourceBlockIndices": [2, 3],
        "rationale": "The four morning talks, in the order they run." },
      { "templateId": "feature-list",
        "copy": {
          "headline": "Afternoon",
          "items": [
            { "title": "1:00 — The talk you didn't give", "body": "Dov Ashkenazi." },
            { "title": "1:45 — Q&A is not the enemy", "body": "Priya Nakamura." },
            { "title": "2:30 — Shipping on a Friday", "body": "Femi Osei." },
            { "title": "3:15 — Closing remarks", "body": "Talia Bergström." } ] },
        "sourceBlockIndices": [4, 5],
        "rationale": "The four afternoon talks — a SECOND feature-list, not folded into the first. One list holds at most five; eight talks needs two lists, not a plan that stops after the first list's worth and calls the rest covered." },
      { "templateId": "cta",
        "copy": {
          "headline": "Doors at nine",
          "body": "First talk at half past.",
          "ctaLabel": "See the full schedule",
          "ctaHref": "https://harrowgate-summit.example/schedule" },
        "sourceBlockIndices": [0, 1],
        "rationale": "The page's own timing, closing the email." }
    ]
  }

Eight talks, two feature-list sections of four. Not one list truncated to its first five and the other three quietly dropped — a second section of the SAME template for the rest, because the page had eight things to say and the template only says five at a time. Nothing here invents a per-talk hero or a portrait for every speaker; the page presents these as a schedule, so the plan stays in the shape the page itself used and repeats the template that shape needs.

## The section catalog

${renderCatalog()}`;
}

/*
  ---------------------------------------------------------------------------
  Validation — deterministic, pure, and never trusting
  ---------------------------------------------------------------------------
*/

/*
  One line per catalog template, generated from SECTION_TEMPLATES.

  Built from the MODEL-FACING schema, not the full one, so the image-source
  field the pipeline writes never appears here. That is the same guarantee
  `scaffoldSection` makes, held in a second place because this listing is a
  second model-facing surface — and a catalog that advertised `imageSrc` would
  hand back exactly the URL-writing ability the rest of this design removes.

  Generated rather than written, so it cannot drift from the real catalog.
*/
function renderCatalog(): string {
  return SECTION_TEMPLATES.map((template) => {
    const schema = getModelFacingParamsSchema(template);
    const shape = (schema as { shape?: Record<string, unknown> }).shape ?? {};
    const params = Object.keys(shape).join(", ");
    return `  ${template.id} — ${template.useWhen}\n      params: ${params}`;
  }).join("\n");
}

/*
  Reconcile a section plan against the catalog and the page.

  Every rule here is about COHERENCE, and none of them reads `pageType`. A
  section naming a template that does not exist, or citing a line the page
  does not have, is wrong whatever kind of page it came from.
*/
/*
  One section exactly as the reader wrote it, before translation.
*/
export interface PlannedSection {
  templateId: string;
  copy: SectionCopy;
  sourceBlockIndices: number[];
  rationale: string;
}

export function validateSections({
  sections,
  scrape,
}: {
  sections: PlannedSection[];
  scrape: PageScrape;
}): { sections: MappedSection[]; droppedParamNames: string[]; rejectedTemplateIds: string[] } {
  /*
    Blocks and lists are numbered as one sequence in the prompt.
  */
  const citableCount = scrape.blocks.length + scrape.lists.length;
  const droppedParamNames: string[] = [];
  const rejectedTemplateIds: string[] = [];

  const kept: MappedSection[] = [];
  for (const section of sections) {
    const template = getSectionTemplate(section.templateId);
    if (template === undefined) {
      continue;
    }
    /*
      A section with no real copy in it would render the template's sample
      text — "Meet the new release" — inside an email the user believes came
      from their page. Dropping it is the honest outcome.
    */
    if (!getHasSubstantiveCopy(section.copy)) {
      rejectedTemplateIds.push(section.templateId);
      continue;
    }
    /*
      A section that cites nothing has nothing on the page behind it. That is
      the signature of copying a worked example rather than reading — the one
      failure mode an example-steered prompt is most prone to.
    */
    const citations = section.sourceBlockIndices.filter(
      (index) => index >= 0 && index < citableCount,
    );
    if (citations.length === 0) {
      continue;
    }
    /*
      The reader writes a flat copy vocabulary; the catalog's real param names
      are produced HERE, deterministically. So a section's params are always
      this pipeline's construction, never a shape the model chose.
    */
    const params = toTemplateParams({
      templateId: section.templateId,
      copy: section.copy,
      pageUrl: scrape.canonicalUrl,
    });

    /*
      THE SILENT FAILURE THIS CLOSES. Catalog schemas are strict and fully
      defaulted, so params the template rejects do not error — the section
      simply falls back to its SAMPLE copy and renders "Meet the new release"
      in an email the user believes was built from their page. That is the
      original defect wearing a better payload, and it is invisible.

      A section whose params the catalog will not accept is therefore dropped.
      A missing section is honest; a section of stock copy pretending to be
      about someone's site is not. Real case: feature-columns requires at least
      two features, so a reader offering one would otherwise have produced a
      confident section about nothing.
    */
    const accepted = template.paramsSchema.safeParse(params);
    if (!accepted.success) {
      rejectedTemplateIds.push(section.templateId);
      continue;
    }

    kept.push({
      templateId: section.templateId,
      params,
      sourceBlockIndices: citations,
      rationale: section.rationale,
    });
  }

  /*
    Report params the catalog will silently discard. The schemas are strict, so
    an unrecognised key makes the WHOLE section fall back to its sample copy —
    a generated email that quietly says nothing about the source, which is the
    original defect in a better disguise. Reporting does not repair it, but it
    turns a silent failure into one somebody can see.
  */
  for (const section of kept) {
    const template = getSectionTemplate(section.templateId);
    if (template === undefined) {
      continue;
    }
    const shape = (template.paramsSchema as { shape?: Record<string, unknown> }).shape ?? {};
    for (const name of Object.keys(section.params)) {
      if (!(name in shape)) {
        droppedParamNames.push(`${section.templateId}.${name}`);
      }
    }
  }

  return { sections: kept, droppedParamNames, rejectedTemplateIds };
}

/*
  Trim to a size, on a word boundary where one is close enough to help.
*/
function clampText(text: string | undefined, limit: number): string | undefined {
  if (text === undefined || text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/*
  Reconcile what the reader said against what is actually on the page.

  Everything here is a rule about COHERENCE, not about page kind. An answer
  naming an image the page does not have, or claiming high confidence while
  refusing to build, is incoherent whatever kind of page it read.
*/
/*
  The reading exactly as it came back, before translation or reconciliation.
  Its sections carry the flat copy vocabulary; `PageClassification`'s carry
  real catalog params, produced here.
*/
export type RawClassification = z.infer<typeof pageClassificationSchema>;

export function validateClassification({
  classification,
  scrape,
}: {
  classification: RawClassification;
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

  /*
    1. A "medium" with nothing to say is really a "high". The agent is
    expected to relay the note, so a medium without one says nothing.
  */
  if (confidence === "medium" && (classification.uncertaintyNote ?? "").trim().length === 0) {
    confidence = "high";
  }

  /*
    2. Low confidence means STOP, whatever else came back. This is the one
    place a reading changes behaviour rather than shape, and it is the
    reason for asking about confidence at all.
  */
  if (confidence === "low") {
    isPlanUsable = false;
  }

  /*
    3. "I am completely sure, and also there is nothing here" is incoherent.
    The confidence is what gives way — a refusal we trust less is still a
    refusal, whereas downgrading the refusal instead would build from a
    page the reader just said it could not use.
  */
  if (!isPlanUsable && confidence === "high") {
    confidence = "medium";
  }

  const { sections } = validateSections({ sections: classification.sections, scrape });

  /*
    A plan-less answer that claims certainty is incoherent in the other
    direction from rule 3: the reader is sure, and produced nothing. Something
    is wrong with the reading, so it stops rather than handing the agent an
    empty plan it will fill from imagination.
  */
  if (sections.length === 0 && isPlanUsable) {
    isPlanUsable = false;
    if (confidence === "high") {
      confidence = "low";
    }
  }

  return {
    ...classification,
    /*
      The sizes the prompt asks for, applied deterministically rather than
      used to reject an otherwise good answer.
    */
    sourceSummary: clampText(classification.sourceSummary, 400) ?? "",
    ...(classification.pageTypeNote === undefined
      ? {}
      : { pageTypeNote: clampText(classification.pageTypeNote, 200) }),
    ...(classification.uncertaintyNote === undefined
      ? {}
      : { uncertaintyNote: clampText(classification.uncertaintyNote, 600) }),
    ...(classification.message === undefined
      ? {}
      : { message: clampText(classification.message, 600) }),
    confidence,
    isPlanUsable,
    images,
    sections,
  };
}

/*
  ---------------------------------------------------------------------------
  The call
  ---------------------------------------------------------------------------
*/

/*
  The classifier's ONLY model dependency. Production passes a generateObject
  wrapper; tests pass a function returning a canned object, or one that
  throws. That makes the prompt, the validation, the floor, and everything
  downstream exercisable without a live call — which matters because the free
  tier is shared with production.
*/
export type ClassifyFn = (input: { prompt: string }) => Promise<unknown>;

/*
  What comes back when the reading could not happen at all — a timeout, an
  exhausted quota, a schema the model did not satisfy, or a run with no model
  behind it.

  It is a SUCCESSFUL, usable answer, not an error. The page was fetched and
  read; only the interpretation is missing. So the floor keeps everything the
  scrape already knows and simply declines to claim more, and it says the
  reading was shallow rather than pretending otherwise.
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
    /*
      No plan. The floor is reached when nothing read the page, and a section
      plan is precisely the thing that requires having read it. Composing from
      the scrape's raw prose here is what the old pipeline did, and it is how
      an email about nothing gets built confidently.
    */
    sections: [],
  };
}

/*
  Classify one scraped page. Never throws.

  A page that was fetched successfully always produces a usable answer — the
  floor when the reading fails. Throwing here would put a page we DID read
  onto the error path, where the model is invited to retry a call that will
  fail the same way and cost the same quota.
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
