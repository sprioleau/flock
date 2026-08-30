import type {
  ReadWebPageBlock,
  ReadWebPageImage,
  ReadWebPageSearchClaim,
  ReadWebPageList,
  ReadWebPagePayload,
  ReadWebPageResult,
} from "@flock/agent";
import {
  classifyPage,
  type ImageRole,
  type MappedSection,
  type PageClassification,
  type ClassifyFn,
} from "./classify-page";
import {
  fetchPage,
  fetchTextResource,
  type FetchFailureReason,
} from "../brand-kit-extraction/fetch-page";
import { derivePageTheme, type PageTheme } from "../brand-kit-extraction/derive-page-theme";
import { extractPage } from "./extract-page";
import type { PageScrape } from "./page-scrape";
import { rehostImageToStorage } from "./rehost-image";
import { createPageClassifier } from "./classify-page-model";
import { isFetchAllowedByRobots } from "./robots";
import { searchPublicWeb } from "./search-web";

/*
  The generic page pipeline: ONE public URL in, what the page ACTUALLY says
  out — or an honest refusal.

  This replaces `ingest-article.ts` and `ingest-person.ts`, which were the same
  four stages twice over, forked on a page type chosen from the user's sentence
  before a single byte had been fetched. There is no page type at this layer.
  Nothing below branches on one, and nothing below may: a page type is a later
  step's OUTPUT, and a `switch` over it here is the deleted fork growing back.

  Stages, in order, each able to stop the pipeline:
    1. robots.txt  — the site's own rules decide whether we may read it, BEFORE
                     any page fetch. `robots.ts` fails OPEN on an unreachable
                     robots.txt and CLOSED on an explicit Disallow.
    2. fetchPage   — the shared, mode-agnostic fetch primitive: SSRF guard on
                     every redirect hop, 5 redirects, 10s deadline, 2MB cap,
                     typed failure reasons.
    3. extractPage — pure HTML → `PageScrape`, including the paywall and
                     no-readable-content refusals.
    3b. theme      — the page's own colours and fonts, derived DETERMINISTICALLY
                     from the HTML stage 2 already fetched (plus its
                     stylesheets), reusing the brand-kit harvester and its
                     contrast-repairing expansion. No model call, and no
                     second page fetch. Fail-soft: no theme is a normal
                     answer, and the draft keeps the theme it had.
    4. lead image  — EXACTLY ONE image is copied into Convex storage, so a
                     composed email never hot-links a CDN that may refuse the
                     recipient's browser. Fail-soft: an image that cannot be
                     stored is DROPPED, never hot-linked and never invented.

  THE HOUSE RULE: A REFUSAL IS NOT AN ERROR. robots Disallow, a fetch failure,
  a paywall, and no readable content all come back as a SUCCESSFUL call
  returning `{ isOk: false, reason, message }` with something worth relaying.
  Throwing would put an unreadable page on the error path, where the model is
  invited to retry — exactly the wrong instinct.
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

/*
  The refusal returned when the site's robots.txt disallows the path.
*/
export const PAGE_ROBOTS_REFUSAL: ReadWebPageResult = {
  isOk: false,
  reason: "blocked_by_robots",
  message:
    "That site's robots.txt asks automated readers to stay off that page, so it wasn't fetched. Nothing was made up in its place — paste the text you'd like to use, or try a page the site allows.",
};

/*
  How many images are worth spending bytes on, and in what order.

  Each copy is a fetch, a storage write, and an Asset Library row, so the cap
  is real rather than defensive. The ORDER is what makes the cap safe: on a
  page with a person on it, their portrait is the image the email most needs,
  and taking images in document order would spend the budget on whatever
  happened to appear first — usually a logo or a social card.
*/
const MAX_REHOSTED_IMAGES = 4;

const IMAGE_ROLE_PRIORITY: readonly ImageRole[] = ["portrait", "logo", "lead", "supporting"];

/*
  Copy the images the reader gave a role to, best roles first, up to the cap.

  CLASSIFICATION RUNS BEFORE ANY COPY, which is the payoff of deferring the
  decision and is a cost win as well as a correctness one: the old pipeline
  copied a hero unconditionally, before anyone knew whether the email would
  use it. Here, bytes are only spent on images something actually asked for.

  Fail-soft per image: one that will not fetch becomes an absent image, never
  a hot-link to the original site and never a substitute.
*/
async function rehostAssignedImages({
  classification,
  scrape,
  sessionId,
}: {
  classification: PageClassification;
  scrape: PageScrape;
  sessionId: string | null;
}): Promise<ReadWebPageImage[]> {
  const candidatesById = new Map(
    scrape.imageCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const ordered = [...classification.images].sort(
    (left, right) =>
      IMAGE_ROLE_PRIORITY.indexOf(left.role) - IMAGE_ROLE_PRIORITY.indexOf(right.role),
  );

  const images: ReadWebPageImage[] = [];
  for (const assignment of ordered) {
    if (images.length >= MAX_REHOSTED_IMAGES) {
      break;
    }
    const candidate = candidatesById.get(assignment.candidateId);
    if (candidate === undefined) {
      continue;
    }
    const url = await rehostImageToStorage({
      imageUrl: candidate.sourceUrl,
      sessionId,
      name: assignment.subject ?? candidate.alt ?? scrape.title,
      sourceUrl: scrape.canonicalUrl,
    });
    if (url === null) {
      continue;
    }
    images.push({
      url,
      role: assignment.role,
      ...(candidate.alt === undefined ? {} : { alt: candidate.alt }),
      ...(assignment.subject === undefined ? {} : { subject: assignment.subject }),
    });
  }
  return images;
}

/*
  `PageScrape` + the reading → `ReadWebPagePayload`, field by field.

  Written out rather than spread, because the difference between the types is
  the point: `linkDensity` is INTERNAL EVIDENCE for admitting a list, not
  something the model needs, so it is dropped here. A `...list` spread would
  silently leak it back the first time either type gained a field.
*/
function toPayload({
  scrape,
  classification,
  images,
  searchClaims,
  theme,
}: {
  scrape: PageScrape;
  classification: PageClassification;
  images: ReadWebPageImage[];
  searchClaims?: ReadWebPageSearchClaim[];
  theme: PageTheme | null;
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
    images,
    isTruncated: scrape.isTruncated,
    /*
      An absent theme means the page gave nothing worth applying — never an
      empty object, which would read as "we looked and the answer is nothing".
    */
    ...(theme === null ? {} : { theme }),
    pageType: classification.pageType,
    ...(classification.pageTypeNote === undefined
      ? {}
      : { pageTypeNote: classification.pageTypeNote }),
    confidence: classification.confidence,
    ...(classification.uncertaintyNote === undefined
      ? {}
      : { uncertaintyNote: classification.uncertaintyNote }),
    sections: classification.sections,
    sourceSummary: classification.sourceSummary,
    isPlanUsable: classification.isPlanUsable,
    ...(classification.message === undefined ? {} : { message: classification.message }),
    ...(searchClaims === undefined || searchClaims.length === 0 ? {} : { searchClaims }),
  };
}

/*
  Which template param carries an image address, per template. Only the seven
  image-bearing templates appear; everything else gets no image.

  The gallery is the odd one out: its images are an ARRAY, so its address lives
  on each element rather than on the params object.
*/
const SINGLE_IMAGE_TEMPLATE_IDS = new Set([
  "hero",
  "hero-split",
  "article",
  "product",
  "header",
  "header-centered",
]);

/*
  Attach the rehosted images to the sections that can carry one.

  THE RULE THIS ENFORCES: the model never writes an image address; the
  pipeline does. The reader emits image IDS and section COPY, and the two are
  joined here, after validation, from URLs that are already in our own
  storage. Any `imageSrc` the reader somehow produced is stripped rather than
  trusted — the catalog listing does not offer the field, so a value in it
  could only have been invented.

  `article` is a deliberate special case: it gates its image on `imageAlt`
  rather than on the source, so passing a source without alt text renders no
  image at all. Both go, or neither.
*/
function attachImagesToSections({
  sections,
  images,
}: {
  sections: MappedSection[];
  images: ReadWebPageImage[];
}): MappedSection[] {
  const ordered = [...images];
  return sections.map((section) => {
    const params = { ...(section.params as Record<string, unknown>) };
    delete params.imageSrc;

    if (section.templateId === "image-gallery") {
      const galleryImages = Array.isArray(params.images) ? params.images : [];
      return {
        ...section,
        params: {
          ...params,
          images: galleryImages.map((image, index) => {
            const rest = { ...((image ?? {}) as Record<string, unknown>) };
            delete rest.src;
            const source = ordered[index];
            return source === undefined ? rest : { ...rest, src: source.url };
          }),
        },
      };
    }

    if (!SINGLE_IMAGE_TEMPLATE_IDS.has(section.templateId)) {
      return { ...section, params };
    }

    const source = ordered.shift();
    if (source === undefined) {
      return { ...section, params };
    }
    const imageAlt = typeof params.imageAlt === "string" ? params.imageAlt : source.alt;
    return {
      ...section,
      params: {
        ...params,
        imageSrc: source.url,
        ...(imageAlt === undefined ? {} : { imageAlt }),
      },
    };
  });
}

export interface IngestPageInput {
  /*
    The page to read, exactly as the user gave it.
  */
  url: string;
  /*
    Session that should own the rehosted images (they join that session's
    Asset Library). Null still rehosts — the files are just unowned.
  */
  sessionId?: string | null;
  /*
    The reading step. Null means don't read — a mock run, or no API key — and
    the classifier falls to its deterministic floor, which is an honest answer
    rather than an error.
  */
  classify?: ClassifyFn | null;
}

/*
  Fetch one public page, read what is on it, and work out what it is — or
  refuse honestly. This is the `readWebPage` action's executor and the
  POST /api/ingest path; both share this exact behavior.

  The ORDER of the last two stages is the design. The page is fetched and
  scraped generically, and only then does anything decide what kind of page it
  was. Nothing above this line knows, and nothing below it branches on the
  answer — the classification is carried out to the model as a fact about the
  page, not consumed as a switch.
*/
export async function ingestPage({
  url,
  sessionId = null,
  classify = null,
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

  /*
    STAGE 3b: the page's own colours and fonts.

    Runs off `page.html` — the bytes stage 2 ALREADY fetched — so the page is
    read once no matter how many things want something from it. The one extra
    request this stage can make is for stylesheets, and that one is unavoidable
    rather than lazy: measured on both judged pages, the HTML alone yields a
    single colour (the theme-color meta tag) and ZERO font families, because a
    modern site's palette lives in its CSS. It is bounded to three sheets, runs
    in parallel through the same SSRF-guarded fetcher, and cost 120–190 ms on
    those pages. The content pipeline still does not fetch CSS for CONTENT —
    prose is not in a stylesheet — so nothing about that decision changes.

    NO MODEL CALL, deliberately: see derive-page-theme.ts. That is what lets
    this run identically on a mock/demo turn, and what keeps a URL draft off a
    free tier already shared five ways with production.

    Fail-safe by construction: derivePageTheme returns null rather than
    throwing, and a null theme leaves the draft wearing the theme it had. A
    theme is a bonus on top of the content, and a bonus must be able to go
    missing without taking the draft with it.
  */
  const theme = await derivePageTheme({
    html: page.html,
    finalUrl: page.finalUrl,
    fetchCss: (cssUrl) => fetchTextResource({ url: cssUrl }),
  });

  const classification = await classifyPage({ scrape, classify });

  /*
    Search runs on the reader's own optional `searchSubject`, and on nothing
    else. The old person pipeline searched UNCONDITIONALLY, building its query
    by concatenating name, role and organization — which meant a live call on
    every profile whether or not anything beyond the page would help.

    Now there is one field and no type branch: the reader states, in its own
    words, that a subject's public record would add something. Absent is the
    normal case. searchPublicWeb still returns "unavailable" unless
    FLOCK_ENABLE_WEB_SEARCH=1 and a key are both present, and a mock run never
    searches at all, so this stays off by default.
  */
  const searchOutcome =
    classification.searchSubject === undefined
      ? null
      : await searchPublicWeb({
          query: classification.searchSubject,
          isMockRun: classify === null,
        });
  const images = await rehostAssignedImages({ classification, scrape, sessionId });
  const sections = attachImagesToSections({ sections: classification.sections, images });

  const searchClaims =
    searchOutcome !== null && searchOutcome.status === "searched" ? searchOutcome.claims : undefined;

  return {
    isOk: true,
    page: toPayload({
      scrape,
      classification: { ...classification, sections },
      images,
      searchClaims,
      theme,
    }),
  };
}

/*
  The session-less adapter injected into the agent action registry (a
  module-level singleton, so it cannot close over a request's session). The
  chat route fulfills the action host-side with the caller's session — see
  app/api/chat/tools.ts.
*/
export async function readWebPage({ url }: { url: string }): Promise<ReadWebPageResult> {
  return ingestPage({ url, classify: createPageClassifier({ isMockRun: false }) });
}
