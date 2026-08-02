import type { PersonHighlightPayload, WebArticlePayload } from "@flock/agent";
import { generateBlockId, ROOT_BLOCK_ID } from "@flock/email-sdk";
import type { AddSectionOperation, Block, TextBlockNode } from "@flock/email-sdk";

/**
 * Deterministic composition of an ingested payload into ONE `addSection`
 * operation.
 *
 * Who uses this: the MOCK chat model (app/api/chat/mock-model.ts). On the real
 * path the agent composes the section itself — that is the plan's design and
 * the whole point of handing the model a faithful payload plus the §7.4
 * guidance. This module is the model's stand-in for the deterministic tier, so
 * the whole fetch → compose → apply → undo flow can be exercised end to end
 * without spending a live model call.
 *
 * It follows the same faithfulness rules the guidance imposes on the model,
 * which is exactly why it is a legitimate stand-in:
 * - every string it emits comes from the payload (title, source name, the
 *   article's own sentences);
 * - the attribution button always points at the payload's canonical URL;
 * - the image is emitted only when the payload actually carries one, and only
 *   at the URL the pipeline stored.
 */

/** Sentence-ish splitter — good enough to pick the opening lines of prose. */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'”’]?)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The first `sentenceCount` sentences of the article body, capped — a
 * condensation of the real text, never a rewrite of it.
 */
export function condenseArticleBody({
  mainText,
  sentenceCount,
  maxChars,
}: {
  mainText: string;
  sentenceCount: number;
  maxChars: number;
}): string {
  const body = mainText.split("\n\n").filter((paragraph) => paragraph.trim().length > 0);
  const sentences = splitIntoSentences(body.join(" ")).slice(0, sentenceCount);
  const condensed = sentences.join(" ");
  return condensed.length <= maxChars ? condensed : `${condensed.slice(0, maxChars).trimEnd()}…`;
}

function textDoc(nodes: TextBlockNode[]) {
  return { type: "doc" as const, content: nodes };
}

/** A section builder that keeps ids, parentIds, and childrenIds consistent. */
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

export interface ComposeArticleSectionInput {
  article: WebArticlePayload;
  /** Where the section goes among the root's children. */
  index: number;
}

/**
 * Compose one article section: headline, the article's own opening lines,
 * the stored lead image when there is one, a byline/date/source credit line,
 * and the read-the-full-story button pointing at the canonical URL.
 */
export function composeArticleSection({
  article,
  index,
}: ComposeArticleSectionInput): AddSectionOperation {
  const section = createSection();
  section.addText([{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: article.title }] }]);
  if (article.heroImageUrl !== undefined) {
    section.addImage({ src: article.heroImageUrl, alt: article.title });
  }
  const summary = condenseArticleBody({
    mainText: article.mainText,
    sentenceCount: 3,
    maxChars: 480,
  });
  if (summary.length > 0) {
    section.addText([{ type: "paragraph", content: [{ type: "text", text: summary }] }]);
  }
  // Credit line: only the fields the page actually declared.
  const creditParts = [article.byline, article.publishedAt].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  const credit =
    creditParts.length === 0
      ? `From ${article.sourceName}`
      : `${creditParts.join(" · ")} — ${article.sourceName}`;
  section.addText([{ type: "paragraph", content: [{ type: "text", text: credit }] }]);
  section.addButton({ label: "Read the full story", href: article.canonicalUrl });
  return section.finish(index);
}

export interface ComposePersonSectionInput {
  person: PersonHighlightPayload;
  index: number;
}

/**
 * Compose one person-highlight section: name, role line, the stored portrait
 * when there is one, the profile's own bio, and the link back to the profile.
 * Facts are used verbatim; nothing is inferred.
 */
export function composePersonSection({
  person,
  index,
}: ComposePersonSectionInput): AddSectionOperation {
  const section = createSection();
  section.addText([{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: person.name }] }]);
  if (person.photoUrl !== undefined) {
    section.addImage({ src: person.photoUrl, alt: `Photo of ${person.name}` });
  }
  const roleParts = [person.role, person.organization].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (roleParts.length > 0) {
    section.addText([{ type: "paragraph", content: [{ type: "text", text: roleParts.join(", ") }] }]);
  }
  const bodyText = person.bio ?? person.facts[0]?.text;
  if (bodyText !== undefined && bodyText.length > 0) {
    section.addText([{ type: "paragraph", content: [{ type: "text", text: bodyText }] }]);
  }
  section.addText([
    { type: "paragraph", content: [{ type: "text", text: `Source: ${person.sourceName}` }] },
  ]);
  section.addButton({ label: "See their full profile", href: person.profileUrl });
  return section.finish(index);
}
