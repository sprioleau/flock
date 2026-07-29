import type { Block, EmailDocument, TextDoc } from "@tandem/email-sdk";

/**
 * Demo-mode prompt composer: turns the CURRENT document into a handful of natural-
 * language chat prompts, the way a user would type them. Composed at click
 * time from the store's live doc — prompts reference real visible content
 * ("the Get started button", the actual heading text), never block ids
 * (user-facing prose rule), and cover a range of block types so the demo
 * storm exercises text edits, property edits, and structural styling through
 * the real chat pipeline.
 *
 * Missing block types are substituted from a generic fallback pool so the
 * result is ALWAYS exactly {@link DEMO_PROMPT_COUNT} prompts. Light
 * template randomization keeps repeat clicks from looking canned.
 */

// Kept small on purpose: Gemini's free tier rate-limits aggressively, and
// each prompt is a full real agent turn (owner-tuned from 6 → 3).
export const DEMO_PROMPT_COUNT = 3;

/** Pick one entry at random (client-side variety; determinism not needed here). */
function pickRandom<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

// ---------------------------------------------------------------------------
// Doc readers
// ---------------------------------------------------------------------------

/** Blocks in document tree order (root-first depth-first walk). */
function listBlocksInTreeOrder(doc: EmailDocument): Block[] {
  const blocksById = doc as Record<string, Block | undefined>;
  const ordered: Block[] = [];
  const visit = (blockId: string): void => {
    const block = blocksById[blockId];
    if (block === undefined) {
      return;
    }
    ordered.push(block);
    for (const childId of block.childrenIds) {
      visit(childId as string);
    }
  };
  visit("root");
  return ordered;
}

type TextBlockNode = TextDoc["content"][number];

/** Plain text of one rich-text node's inline content. */
function flattenInlineText(node: TextBlockNode): string {
  return (node.content ?? [])
    .map((inline) => (inline.type === "text" ? inline.text : " "))
    .join("")
    .trim();
}

/** The first heading's text in a text block's doc, or null. */
function findHeadingText(text: TextDoc): string | null {
  for (const node of text.content) {
    if (node.type === "heading") {
      const headingText = flattenInlineText(node);
      if (headingText.length > 0) {
        return headingText;
      }
    }
  }
  return null;
}

/** A short quotable phrase (first few words) from the first non-empty paragraph. */
function findParagraphPhrase(text: TextDoc): string | null {
  for (const node of text.content) {
    if (node.type !== "paragraph") {
      continue;
    }
    const paragraphText = flattenInlineText(node);
    if (paragraphText.length === 0) {
      continue;
    }
    const words = paragraphText.split(/\s+/).filter((word) => word.length > 0);
    const phrase = words.slice(0, Math.min(5, words.length)).join(" ");
    // Strip a trailing sentence terminator so the quote reads naturally.
    return phrase.replace(/[.,;:!?]+$/, "");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt builders (one per block-type category, each with template variants)
// ---------------------------------------------------------------------------

const ACCENT_COLOR_NAMES = ["deep violet", "forest green", "warm coral", "navy blue"] as const;
const BUTTON_LABEL_IDEAS = ["Start now", "Join the ride", "Try Tandem free", "Count me in"] as const;
const TONE_WORDS = ["more playful", "shorter and punchier", "warmer and more personal"] as const;

function buildPromptCandidates(doc: EmailDocument): string[] {
  const blocks = listBlocksInTreeOrder(doc);
  const buttonBlock = blocks.find((block) => block.type === "button");
  const imageBlock = blocks.find((block) => block.type === "image");
  const hasDivider = blocks.some((block) => block.type === "divider");
  const textBlocks = blocks.filter((block) => block.type === "text");

  const headingText = textBlocks
    .map((block) => findHeadingText(block.properties.text))
    .find((text) => text !== null);
  // Prefer a phrase from a DIFFERENT text block than the heading's, when there is one.
  const paragraphPhrase = textBlocks
    .map((block) => findParagraphPhrase(block.properties.text))
    .find((text) => text !== null);

  const candidates: string[] = [];

  if (buttonBlock !== undefined) {
    const label = buttonBlock.properties.label;
    candidates.push(
      pickRandom([
        `Change the "${label}" button's background to ${pickRandom(ACCENT_COLOR_NAMES)}`,
        `Rename the "${label}" button to "${pickRandom(BUTTON_LABEL_IDEAS)}"`,
      ]),
    );
  }
  if (headingText !== undefined && headingText !== null) {
    candidates.push(
      pickRandom([
        `Rewrite the "${headingText}" heading to be ${pickRandom(TONE_WORDS)}`,
        `Give the "${headingText}" heading a color that pops`,
      ]),
    );
  }
  if (paragraphPhrase !== undefined && paragraphPhrase !== null) {
    candidates.push(
      pickRandom([
        `Bold the phrase "${paragraphPhrase}"`,
        `Rewrite the paragraph that starts with "${paragraphPhrase}" to be ${pickRandom(TONE_WORDS)}`,
      ]),
    );
  }
  if (imageBlock !== undefined) {
    const alt = imageBlock.properties.alt;
    const imageDescription = alt.length > 0 ? `the "${alt}" image` : "the image";
    candidates.push(
      pickRandom([
        `Make ${imageDescription} a bit narrower and keep it centered`,
        `Swap ${imageDescription} for https://placehold.co/600x300 and update its alt text to match`,
      ]),
    );
  }
  if (hasDivider) {
    candidates.push(
      pickRandom([
        "Give the divider a subtle accent color and a little more breathing room",
        "Make the divider thicker so the sections feel more separated",
      ]),
    );
  }
  if (buttonBlock !== undefined) {
    // A second button-adjacent edit rounds out the set on the sample doc:
    // vary between the CTA and document-wide styling.
    candidates.push(
      pickRandom([
        `Give the "${buttonBlock.properties.label}" button rounder corners`,
        "Make the call-to-action stand out more",
      ]),
    );
  }
  return candidates;
}

/** Generic prompts that apply to any document (fill when block types are missing). */
const FALLBACK_PROMPTS = [
  "Change the email background color to a gentle pastel",
  "Center-align all the headings",
  "Add a short P.S. line at the end of the email",
  "Add a divider between the main sections",
  "Make the overall typography feel a little more modern",
  "Add a friendly one-line intro at the top of the email",
] as const;

/**
 * Exactly {@link DEMO_PROMPT_COUNT} varied prompts for the given document:
 * doc-derived candidates first, topped up from the fallback pool.
 */
export function composeDemoPrompts(doc: EmailDocument): string[] {
  const prompts = buildPromptCandidates(doc).slice(0, DEMO_PROMPT_COUNT);
  for (const fallback of FALLBACK_PROMPTS) {
    if (prompts.length >= DEMO_PROMPT_COUNT) {
      break;
    }
    prompts.push(fallback);
  }
  return prompts;
}
