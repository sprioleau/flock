import { generateDocumentOutline } from "@flock/agent";
import type { Block, EmailDocument, GlobalStyles } from "@flock/email-sdk";

/**
 * Prompt construction for the drafts menu's AI generation actions ("Ideate
 * with AI" / "Add design variation") — pure and unit-testable. The flow
 * itself lives in DraftSelector: create an EMPTY draft, seed it with the
 * source draft's theme (variation only), activate it, then submit one of
 * these prompts through the chat panel's own send path (composer-handoff
 * SEND) so the user sees the request land in the thread and the sections
 * stream in — the same transparency contract as slash-summon, and NO second
 * pipeline.
 *
 * Both prompts deliberately contain the phrase "complete email": the live
 * model reads it as plain intent, and the deterministic mock model's
 * full-email compose script keys off it (mock-model.ts COMPOSE_EMAIL_REGEX),
 * so tests exercise the real per-section streaming pipeline.
 *
 * The SOURCE draft rides inside the prompt TEXT — the request body only
 * carries the NEW (blank) draft, so the prompt is the only channel the source
 * can reach the model through.
 *
 * ONE EXTRACTOR, TWO FIDELITIES. Both paths render the source with the
 * agent package's `generateDocumentOutline` — the same deterministic,
 * token-budgeted view the chat turn itself uses. This module owns only the
 * question of HOW MUCH of it travels, which is a single option:
 *
 * - "Ideate with AI" wants a fresh concept, so it takes the default 60-char
 *   clip. Subject matter and audience survive; the wording does not, which is
 *   the point — a fuller quote would pull the model into rewriting the same
 *   email.
 * - "Add design variation" must keep the words, so it raises the clip to
 *   {@link VARIATION_MAX_TEXT_CHARS}. The reported bug was partly this number:
 *   the owner's ~200-character paragraph reached the model as a third of
 *   itself, and the model filled the hole from the section templates' own
 *   sample copy.
 *
 * DEPTH STAYS "blocks" FOR BOTH, deliberately. "sections" carries no copy at
 * all, and "full" appends every explicitly-set style property of every block —
 * a blueprint the model can transcribe, which is the exact failure mode a
 * design VARIATION has to avoid, and the most expensive option on a free-tier
 * quota. "blocks" tells the model what the email contains and roughly how it
 * groups, and nothing about how it is styled.
 */

/**
 * Characters of copy quoted per text block when reimagining a draft.
 *
 * The clip applies to a whole text block — heading and paragraph joined — so
 * it has to clear both together, not just a paragraph. Measured against the
 * current (rich) starter document, the cost curve is nearly flat past a few
 * hundred: 60 → ~379 tokens, 300 → ~697, 400 → ~722, 600 → ~772, 900 → ~798.
 * Almost everything is the structure, not the copy. 600 therefore buys real
 * headroom for ~50 tokens over the point where the owner's own paragraph
 * would have survived — worth paying on a free-tier quota, where a clipped
 * paragraph costs a whole wasted generation.
 */
export const VARIATION_MAX_TEXT_CHARS = 600;

/** Most images listed in the variation's image appendix. */
const MAX_LISTED_IMAGES = 8;

// ---------------------------------------------------------------------------
// Source views
// ---------------------------------------------------------------------------

/**
 * The lossy sketch behind "Ideate with AI": enough to know what the email is
 * about, not enough to rewrite it.
 */
export function buildIdeationOutline(doc: EmailDocument): string {
  // The shared outline still describes an empty document ("(no sections)");
  // both prompts treat "" as "there is no source worth mentioning".
  return hasContent(doc) ? generateDocumentOutline({ doc }) : "";
}

/** Whether this draft has anything in it at all. */
function hasContent(doc: EmailDocument): boolean {
  return (doc.root?.childrenIds ?? []).length > 0;
}

/** Blocks in reading order, depth-first from the root. */
function walkBlocksInReadingOrder(doc: EmailDocument): Block[] {
  const ordered: Block[] = [];
  const visit = (blockId: string): void => {
    const block = doc[blockId];
    if (block === undefined) {
      return;
    }
    ordered.push(block);
    for (const childId of block.childrenIds) {
      visit(childId);
    }
  };
  for (const sectionId of doc.root?.childrenIds ?? []) {
    visit(sectionId);
  }
  return ordered;
}

/**
 * The exact image files the source uses, deduped, in reading order.
 *
 * The shared outline deliberately reduces an image src to its HOST ("image
 * srcs are long and rarely what the model needs at skim depth" — outline.ts),
 * which is right for editing a document that already holds the images and
 * wrong here: this prompt builds a DIFFERENT, empty draft, every section
 * template ships a grey placeholder, and "move the image somewhere new" is
 * meaningless if the image cannot come with it. So the addresses ride
 * separately rather than by widening the shared view for everyone.
 */
function listSourceImages(doc: EmailDocument): string {
  const seenSources = new Set<string>();
  const lines: string[] = [];
  for (const block of walkBlocksInReadingOrder(doc)) {
    if (block.type !== "image" || seenSources.has(block.properties.src)) {
      continue;
    }
    seenSources.add(block.properties.src);
    lines.push(`- "${block.properties.alt}" → ${block.properties.src}`);
    if (lines.length === MAX_LISTED_IMAGES) {
      break;
    }
  }
  return lines.join("\n");
}

/**
 * Everything the source draft SAYS, at full copy fidelity, plus the addresses
 * of the pictures it uses. "" for a draft with nothing in it.
 */
export function buildVariationBrief(doc: EmailDocument): string {
  if (!hasContent(doc)) {
    return "";
  }
  const outline = generateDocumentOutline({
    doc,
    options: { maxTextChars: VARIATION_MAX_TEXT_CHARS },
  });
  const images = listSourceImages(doc);
  return images.length === 0 ? outline : `${outline}\n\nThe pictures it uses:\n${images}`;
}

// ---------------------------------------------------------------------------
// Theme carry-over
// ---------------------------------------------------------------------------

/**
 * The theme a design variation must open wearing, or null when there is
 * nothing to carry.
 *
 * A draft whose theme has never been touched holds NO globals of its own and
 * renders on the shared defaults — so does the blank draft the variation is
 * built in, and copying `{}` around would only add a no-op to its history.
 * Anything else is a theme the person chose and is currently looking at, and
 * it is not the model's to reconsider: the caller writes it into the new draft
 * as one `applyTheme` op before the prompt is ever sent. Theme inheritance is
 * therefore ON by default and cannot be lost to a model that ignores an
 * instruction; only the person's own words release it.
 */
export function readSourceThemeGlobals(doc: EmailDocument): GlobalStyles | null {
  const root = doc.root;
  if (root === undefined || root.type !== "root") {
    return null;
  }
  const globals = root.properties.globals ?? {};
  return Object.keys(globals).length > 0 ? globals : null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * "Ideate with AI": a fresh concept for this canvas. The source outline is
 * inspiration — subject matter and audience — not a layout to copy.
 */
export function buildIdeateDraftPrompt({
  sourceDraftName,
  sourceOutline,
}: {
  sourceDraftName: string;
  sourceOutline: string;
}): string {
  const contextBlock =
    sourceOutline.length > 0
      ? `For context, here is a content outline of "${sourceDraftName}", another draft on this canvas:\n\n${sourceOutline}\n\n`
      : "";
  return (
    `Design a complete email from scratch in this blank draft. ` +
    `${contextBlock}` +
    `Treat that as inspiration for the subject matter and audience — come up with a fresh concept and layout rather than copying it, ` +
    `and feel free to try a different theme or visual feel. Build the email section by section.`
  );
}

export interface DesignVariationPromptInput {
  /** The draft being reimagined, by its user-facing name. */
  sourceDraftName: string;
  /** {@link buildVariationBrief} of the source draft. */
  sourceBrief: string;
  /**
   * Whether the source draft's theme is already in place on the new draft
   * (DraftSelector seeds it before sending). False only when that seeding
   * failed — then the model is asked to match the source's look itself.
   */
  hasSourceTheme: boolean;
  /**
   * What the person typed in the "Anything to change?" field, verbatim and
   * unparsed. This is the ONLY channel through which "make it lighter" can
   * reach the theme decision — the client never inspects it, the model reads
   * it as plain instruction.
   */
  direction: string;
}

/**
 * "Add design variation": the SAME email, redesigned.
 *
 * The whole prompt turns on one asymmetry — CONTENT IS FIXED, STRUCTURE IS
 * FREE. Handing a model the full source without that split makes it
 * reproduce the design it was shown; freeing the content instead is the
 * reported bug (a dark, personal email came back as white generic SaaS
 * marketing copy, because every unspecified section param falls back to the
 * template's own sample text). So the brief is introduced as what the email
 * SAYS, the structural moves are enumerated concretely — columns, section
 * order and count, image placement and size — and reusing sample copy is
 * named and forbidden.
 *
 * The theme is NOT left to the model: DraftSelector has already applied the
 * source theme to this draft. The only thing that can release it is the
 * person's own words, quoted below.
 */
export function buildDesignVariationPrompt({
  sourceDraftName,
  sourceBrief,
  hasSourceTheme,
  direction,
}: DesignVariationPromptInput): string {
  const trimmedDirection = direction.trim();
  const sections: string[] = [
    `Design a complete email in this blank draft: a new take on "${sourceDraftName}", using that draft's own content.`,
    hasSourceTheme
      ? `The theme from "${sourceDraftName}" is already applied to this draft. Keep it — same colours, same fonts, same spacing — unless the person's direction below asks for something different.`
      : `Match the look and feel of "${sourceDraftName}" — this is a layout variation, not a recolour.`,
  ];
  if (sourceBrief.length > 0) {
    sections.push(
      `Here is what "${sourceDraftName}" SAYS, in reading order. Read it for its words and its pictures — the arrangement it happens to be in right now is the one thing you are being asked to change. The block ids belong to that other draft; this draft is empty, so never refer to them.\n\n${sourceBrief}`,
    );
  }
  sections.push(
    [
      "How to build the variation:",
      "",
      "1. KEEP THE WORDS. Every headline, paragraph, button label, link and image above belongs in this email, saying the same thing about the same subject. Reword only as much as a new layout demands. Never substitute sample or marketing copy — no invented company, product or tagline that is not in the brief above. When you add a section, pass it the real copy from the brief; a section left with its own default text is a failure, not a placeholder.",
      "2. CHANGE THE STRUCTURE. This must read as a different design at a glance, not the same email with new spacing. Do at least three of: turn a stacked section into side-by-side columns (or the reverse); change how many columns a row has, or their widths; change the order the sections appear in; change how many sections there are; split one dense section into two, or fold two into one.",
      "3. MOVE THE IMAGERY. Put the image somewhere it was not — leading the email, beside the copy instead of above it, or full width and much larger. Reuse the same image addresses listed above rather than leaving placeholder pictures in place.",
      "4. ADD SOMEWHERE FOR THE EYE TO REST. Include one section the source does not have — a pull quote, a stat, a short highlight row — and fill it with real content drawn from the copy above.",
      "",
      "You have real creative freedom over the shape of this email. You have none over what it says.",
    ].join("\n"),
  );
  if (trimmedDirection.length > 0) {
    sections.push(
      `The person asked for this specifically: "${trimmedDirection}"\n` +
        `Follow it. If it asks for different colours, a different theme, or a different mood, change the theme to match — that instruction outranks keeping the current one.`,
    );
  }
  sections.push("Build the email section by section.");
  return sections.join("\n\n");
}
