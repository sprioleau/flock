import {
  ROOT_BLOCK_ID,
  resolveBlockStyles,
  resolveGlobalStyles,
  type Block,
  type BlockId,
  type EmailDocument,
  type GlobalStyles,
} from "@flock/email-sdk";
import { getContrastRatio, MIN_THEME_CONTRAST_RATIO } from "@/lib/brand-kit";
import { repairForegroundContrast } from "@/lib/brand-kit-extraction/expand-variations";
import { getAncestorIds } from "@/lib/get-ancestor-ids";

/*
  THE MEASURING INSTRUMENT BEHIND THE `low-contrast-edit` CRITIQUE (§10 row 7).

  Every other suggestion rule detects a PATTERN — "you did this twice, want the
  rest?". A critique instead says the user's own edit is wrong, so it may only
  ever speak when it can PROVE the claim. That is the whole reason this module
  exists separately from rules.ts: it turns a block into an exact, resolved
  foreground/background pair and a WCAG threshold, or it returns null and the
  rule stays quiet. Nothing here has an opinion about taste.

  THE THRESHOLD IS NOT A NEW OPINION. It is `MIN_THEME_CONTRAST_RATIO` (4.5:1)
  — the same bar `getBrandKitValidationErrors` already enforces server-side, so
  a brand kit whose button label sits below it CANNOT BE STORED. Critiquing a
  hand edit at that bar applies the project's existing rule to a surface that
  had escaped it, rather than inventing a standard.

  ...with the one WCAG exemption that keeps it honest: large text passes at
  3:1. Ignoring that would make the rule fire on legibly large type, which is
  the false positive that costs the most trust.

  WHICH BLOCKS ARE JUDGED, AND WHY NOT THE OTHERS:

  - button — the canonical case. Label on fill, both resolved on the block
    itself, and the label color is INSTRUMENTAL: it exists to be read, so
    correcting it is a fix rather than a difference of taste.
  - link — a standalone link's color against whatever container background is
    actually behind it, at the size it actually renders.
  - NOT text blocks. One text block renders headings and paragraphs at
    different sizes (and per-span font-size marks on top), so a single
    threshold cannot judge the block: a 32px heading at 3.5:1 PASSES while the
    paragraph beneath it at the same color FAILS. A rule that cannot say which
    is not allowed to say anything.
  - NOT sections or globals. Recoloring a section background can strand every
    descendant, which is real — but the fix is then a multi-block batch with a
    genuine choice in it (repair the background, or every text color under it).
    That is a different rule with its own ladder, not this one.
*/

/*
  WCAG 2.1: text at 24px (18pt), or 18.66px bold, clears at 3:1 instead.
*/
export const LARGE_TEXT_MIN_RATIO = 3;
export const LARGE_TEXT_MIN_FONT_SIZE_PX = 24;

/*
  One measured legibility claim: the resolved pair, its ratio, and the bar.
*/
export interface ContrastSubject {
  foreground: string;
  background: string;
  /*
    WCAG contrast ratio, 1–21.
  */
  ratio: number;
  /*
    The bar this pair has to clear (4.5, or 3 for large text).
  */
  minRatio: number;
  isFailing: boolean;
}

/*
  The properties whose edit can MOVE the pair. A critique speaks about the edit
  that just landed, so an edit to anything else — padding, radius, alignment —
  never resurfaces a defect the user did not just touch. Font size is here
  because it moves the THRESHOLD, which is the same thing as moving the verdict.
*/
const CRITIQUE_PROPERTY_KEYS: Partial<Record<Block["type"], ReadonlySet<string>>> = {
  button: new Set(["backgroundColor", "textColor"]),
  link: new Set(["textColor", "fontSize"]),
};

/*
  Could an edit to this property have created a contrast defect on this block?
*/
export function getIsContrastCritiqueProperty({
  blockType,
  propertyKey,
}: {
  blockType: Block["type"];
  propertyKey: string;
}): boolean {
  return CRITIQUE_PROPERTY_KEYS[blockType]?.has(propertyKey) ?? false;
}

function getDocumentGlobals(doc: EmailDocument): GlobalStyles | undefined {
  const rootBlock = doc[ROOT_BLOCK_ID];
  return rootBlock?.type === "root" ? rootBlock.properties.globals : undefined;
}

/*
  The color a reader actually sees behind a block — the renderer's own cascade,
  walked innermost-first: the nearest column or row that paints a background
  wins, else the section's resolved inner background, else the globals content
  background. Undefined at row/column level means transparent, which is exactly
  "keep looking outward".
*/
export function resolveBackgroundBehind({
  doc,
  blockId,
}: {
  doc: EmailDocument;
  blockId: BlockId;
}): string {
  const globals = getDocumentGlobals(doc);
  const ancestorIds = getAncestorIds({ doc, blockId });
  for (const ancestorId of [...ancestorIds].reverse()) {
    const ancestor = doc[ancestorId];
    if (ancestor === undefined) {
      continue;
    }
    if (ancestor.type === "column" || ancestor.type === "row") {
      const { backgroundColor } = resolveBlockStyles(globals, ancestor);
      if (backgroundColor !== undefined) {
        return backgroundColor;
      }
      continue;
    }
    if (ancestor.type === "section") {
      return resolveBlockStyles(globals, ancestor).innerBackgroundColor;
    }
  }
  return resolveGlobalStyles(globals).contentBackgroundColor;
}

function measure({
  foreground,
  background,
  minRatio,
}: {
  foreground: string;
  background: string;
  minRatio: number;
}): ContrastSubject | null {
  const ratio = getContrastRatio({ foreground, background });
  if (ratio === null) {
    /*
      Not hex we can read (a named color, a gradient) — never guess a verdict.
    */
    return null;
  }
  return { foreground, background, ratio, minRatio, isFailing: ratio < minRatio };
}

/*
  The legibility claim for one block, or null when it cannot be measured.
*/
export function getContrastSubject({
  doc,
  block,
}: {
  doc: EmailDocument;
  block: Block;
}): ContrastSubject | null {
  const globals = getDocumentGlobals(doc);
  if (block.type === "button") {
    const styles = resolveBlockStyles(globals, block);
    return measure({
      foreground: styles.textColor,
      background: styles.backgroundColor,
      minRatio: MIN_THEME_CONTRAST_RATIO,
    });
  }
  if (block.type === "link") {
    const styles = resolveBlockStyles(globals, block);
    return measure({
      foreground: styles.textColor,
      background: resolveBackgroundBehind({ doc, blockId: block.id }),
      minRatio:
        styles.fontSize >= LARGE_TEXT_MIN_FONT_SIZE_PX
          ? LARGE_TEXT_MIN_RATIO
          : MIN_THEME_CONTRAST_RATIO,
    });
  }
  return null;
}

/*
  The corrected foreground, or null when there is nothing to correct.

  Reuses `repairForegroundContrast` — the brand-kit pipeline's repair pass —
  rather than reinventing it, so the color a critique proposes is the SAME
  color the scrape pipeline would have produced for that pair. It steps the
  user's own color toward black or white only as far as 4.5:1 requires, which
  is what keeps the fix a correction rather than a re-decision: a washed-out
  brand blue stays blue instead of snapping to #000000.
*/
export function getContrastFixColor(subject: ContrastSubject): string | null {
  const fixColor = repairForegroundContrast({
    foreground: subject.foreground,
    background: subject.background,
  });
  return fixColor.trim().toLowerCase() === subject.foreground.trim().toLowerCase()
    ? null
    : fixColor;
}
