import { generateBlockId, ROOT_BLOCK_ID } from "@flock/email-sdk";
import type { AddSectionOperation, Block, TextBlockNode } from "@flock/email-sdk";
/*
  TEMPORARY IMPORT PATH — see the note in `ingest-page.ts`. Type-only, and a
  one-line swap to `@flock/agent` once that package re-exports the contract.
*/
import type { ReadWebPagePayload } from "../../../../../packages/agent/src/read-web-page";

/*
  Deterministic composition of ONE scraped page into ONE `addSection`
  operation.

  Who uses this: the MOCK chat model (app/api/chat/mock-model.ts). On the real
  path the agent composes the section itself — that is the design, and the
  whole point of handing the model a faithful payload. This module is the
  model's stand-in for the deterministic tier, so the whole read → compose →
  apply → undo flow can be exercised without spending a live model call.

  ONE composer, because there is one tool. It replaces `composeArticleSection`
  and `composePersonSection`, which existed only because the layer above them
  had already forked on page type. With that fork gone there is nothing left to
  pick between: this reads a `ReadWebPagePayload` and emits whatever the page
  actually gave up. A prose-heavy article contributes sentences and no lists; a
  lean portfolio contributes lists and almost no sentences; the same code walks
  both, and neither one is named anywhere below.

  It follows the same faithfulness rules the guidance imposes on the model,
  which is what makes it a legitimate stand-in:
  - every string it emits is copied out of the payload;
  - the attribution button always points at the payload's canonical URL;
  - the image is emitted only when the payload actually carries one, and only
    at the URL the pipeline stored.
*/

/*
  At most this many of the page's lists reach the section.
*/
const MAX_RENDERED_LISTS = 3;

/*
  At most this many items from any one list.
*/
const MAX_RENDERED_LIST_ITEMS = 8;

/*
  Opening sentences of prose to keep, and their character budget.
*/
const SUMMARY_SENTENCE_COUNT = 3;
const SUMMARY_MAX_CHARS = 480;

/*
  Sentence-ish splitter — good enough to pick the opening lines of prose.
*/
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'”’]?)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/*
  The first `sentenceCount` sentences of a page's prose, capped — a
  condensation of the real text, never a rewrite of it.

  This is `condenseArticleBody` from `compose-article-section.ts`, carried over
  so it survives that file's removal. Only its name changed: "article" was a
  page type, and there are none of those here.
*/
export function condenseProse({
  prose,
  sentenceCount,
  maxChars,
}: {
  prose: string;
  sentenceCount: number;
  maxChars: number;
}): string {
  const body = prose.split("\n\n").filter((paragraph) => paragraph.trim().length > 0);
  const sentences = splitIntoSentences(body.join(" ")).slice(0, sentenceCount);
  const condensed = sentences.join(" ");
  return condensed.length <= maxChars ? condensed : `${condensed.slice(0, maxChars).trimEnd()}…`;
}

function textDoc(nodes: TextBlockNode[]) {
  return { type: "doc" as const, content: nodes };
}

/*
  A section builder that keeps ids, parentIds, and childrenIds consistent.
*/
function createSection() {
  const sectionId = generateBlockId("section");
  const children: Block[] = [];
  const childrenIds: string[] = [];
  const push = (block: Block): void => {
    children.push(block);
    childrenIds.push(block.id);
  };
  return {
    sectionId,
    addText: (content: TextBlockNode[]): void => {
      push({
        id: generateBlockId("text"),
        type: "text",
        parentId: sectionId,
        childrenIds: [],
        properties: { text: textDoc(content) },
      });
    },
    addImage: ({ src, alt }: { src: string; alt: string }): void => {
      push({
        id: generateBlockId("image"),
        type: "image",
        parentId: sectionId,
        childrenIds: [],
        properties: { src, alt },
      });
    },
    addButton: ({ label, href }: { label: string; href: string }): void => {
      push({
        id: generateBlockId("button"),
        type: "button",
        parentId: sectionId,
        childrenIds: [],
        properties: { label, href },
      });
    },
    finish: (index: number): AddSectionOperation => ({
      name: "addSection",
      section: {
        id: sectionId,
        type: "section",
        parentId: ROOT_BLOCK_ID,
        childrenIds,
        properties: {},
      },
      index,
      children,
    }),
  };
}

export interface ComposeScrapedSectionInput {
  page: ReadWebPagePayload;
  /*
    Where the section goes among the root's children.
  */
  index: number;
}

/*
  Compose one section from a page that was read: its title, the stored lead
  image when there is one, its own opening sentences (or, when it barely wrote
  any, its own summary line), the lists it wrote, a source credit, and the
  attribution button pointing at the canonical URL.

  The prose and the lists are not alternatives chosen by a page kind — both are
  emitted whenever the page has them, and a page that has only one of the two
  simply contributes only that. That is the whole difference between this and
  the two composers it replaces.
*/
export function composeScrapedSection({
  page,
  index,
}: ComposeScrapedSectionInput): AddSectionOperation {
  const section = createSection();
  section.addText([
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: page.title }] },
  ]);
  /*
    The best image the reader kept, by role rather than by position. A portrait
    outranks a logo outranks the page's own lead — on a page about a person,
    their face is what the email most needs, and taking images in document
    order usually lands on a logo or a social card instead.
  */
  const [headlineImage] = page.images;
  if (headlineImage !== undefined) {
    section.addImage({ src: headlineImage.url, alt: headlineImage.alt ?? page.title });
  }

  /*
    The page's own opening lines. A page whose prose was mostly lists leaves
    this empty, and its own meta description stands in — still the page's
    words, never ours.
  */
  const prose = page.blocks
    .filter((block) => block.kind === "paragraph")
    .map((block) => block.text)
    .join("\n\n");
  const summary = condenseProse({
    prose,
    sentenceCount: SUMMARY_SENTENCE_COUNT,
    maxChars: SUMMARY_MAX_CHARS,
  });
  const intro = summary.length > 0 ? summary : (page.description ?? "");
  if (intro.length > 0) {
    section.addText([{ type: "paragraph", content: [{ type: "text", text: intro }] }]);
  }

  /*
    Lists arrive as lists and leave as lists. `headingBefore` is what tells a
    reader that these six strings are a skills list rather than six loose words,
    so it is emitted as the heading it was — the one piece of context the old
    prose-only channel destroyed.
  */
  for (const list of page.lists.slice(0, MAX_RENDERED_LISTS)) {
    const items = list.items.slice(0, MAX_RENDERED_LIST_ITEMS);
    if (items.length === 0) {
      continue;
    }
    if (list.headingBefore !== undefined && list.headingBefore.length > 0) {
      section.addText([
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: list.headingBefore }],
        },
      ]);
    }
    section.addText([
      { type: "paragraph", content: [{ type: "text", text: items.join(" · ") }] },
    ]);
  }

  section.addText([
    { type: "paragraph", content: [{ type: "text", text: `From ${page.sourceName}` }] },
  ]);
  section.addButton({ label: "View the original", href: page.canonicalUrl });
  return section.finish(index);
}
