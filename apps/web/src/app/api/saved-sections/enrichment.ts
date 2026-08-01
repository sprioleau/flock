import type { Block } from "@flock/email-sdk";
import { z } from "zod";

/**
 * Saved-section enrichment (owner V2 item 2): after a save, an ASYNC,
 * fails-soft call authors the row's `useWhen` (the catalog templates'
 * selection guidance analogue — "footer" tells the model nothing; "use as
 * the closing footer, already carries the user's real unsubscribe and
 * social links" tells it everything) and a structural `description`.
 *
 * Two paths, one output shape:
 * - MODEL (gemini-3.5-flash-lite, the personas bucket): one small
 *   generateObject call over the section's compact outline, steered by the
 *   axes below.
 * - DETERMINISTIC (mock header, no API key, or model failure): a pure
 *   structural analysis of the subtree — unit-tested, quota-free, and the
 *   guaranteed floor: every saved row can be enriched even offline.
 *
 * Length: guidance lives in the prompt; storage truncates on receipt
 * (convex/model/savedSections.ts ENRICHMENT_TEXT_CAPS — the personas
 * finding-schema pattern).
 */

/** What the model must return — also the deterministic path's output shape. */
export const savedSectionEnrichmentSchema = z.object({
  useWhen: z
    .string()
    .describe(
      "One sentence (max ~30 words) telling an email-composing assistant WHEN to pick this saved section over alternatives. Start with 'Use'.",
    ),
  description: z
    .string()
    .describe(
      "One or two sentences (max ~45 words) describing the section's layout structure and content inventory, so it can be compared against a request without seeing the blocks.",
    ),
});

export type SavedSectionEnrichment = z.infer<typeof savedSectionEnrichmentSchema>;

/**
 * The selection axes the model covers (owner list + additions 5–7): what
 * actually predicts whether a saved section fits a compose request.
 */
const ENRICHMENT_AXES = `Cover whichever of these axes the section actually exhibits:
1. Layout structure — rows/columns arrangement, media-beside-text, stacked vs grid.
2. Content inventory — logo, nav links, headline, CTA buttons, person photo + bio, legal/unsubscribe text, social links.
3. Purpose/genre fit — newsletter digest, product launch, transactional notice, announcement, editorial/article.
4. Tone and density — minimal vs rich, formal vs playful, text-heavy vs visual.
5. Personalization — whether it already carries the user's REAL details (brand name, addresses, URLs, socials), making it reusable as-is without edits.
6. Placement affinity — reads as a top/header block, a body block, or a bottom/footer block.
7. Theme coupling — inherits the document theme vs carries its own hard-coded colors/fonts.`;

/** Build the one-shot enrichment prompt over the section's compact outline. */
export function buildEnrichmentPrompt({
  name,
  outline,
}: {
  name: string;
  outline: string;
}): string {
  return [
    `A user of an email editor saved a reusable section named "${name}". Below is its compact outline (block tree + truncated text).`,
    "Write `useWhen` — ONE sentence (max ~30 words, starting with \"Use\") telling an email-composing assistant when to pick this section — and `description` — one or two sentences (max ~45 words) on its structure and contents.",
    ENRICHMENT_AXES,
    "Be concrete and specific to THIS section (quote its actual labels/details where useful); never generic filler.",
    "",
    "```",
    outline,
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic path (mock / no key / model-failure floor)
// ---------------------------------------------------------------------------

interface SectionInventory {
  columnCountsPerRow: number[];
  imageCount: number;
  buttonLabels: string[];
  standaloneLinkCount: number;
  headingTexts: string[];
  paragraphCount: number;
  hasLogoImage: boolean;
  hasUnsubscribeText: boolean;
  hasLegalText: boolean;
  hasSocialLinks: boolean;
}

const SOCIAL_HOST_REGEX =
  /\b(?:x\.com|twitter\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|threads\.net)\b/i;

/** Flatten one text block's runs to a plain string (hard breaks → spaces). */
function flattenTextBlock(block: Extract<Block, { type: "text" }>): string {
  return block.properties.text.content
    .map((node) =>
      (node.content ?? []).map((run) => (run.type === "text" ? run.text : " ")).join(""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure structural read of a saved subtree (root-first flat list). */
export function analyzeSectionSubtree(blocks: readonly Block[]): SectionInventory {
  const inventory: SectionInventory = {
    columnCountsPerRow: [],
    imageCount: 0,
    buttonLabels: [],
    standaloneLinkCount: 0,
    headingTexts: [],
    paragraphCount: 0,
    hasLogoImage: false,
    hasUnsubscribeText: false,
    hasLegalText: false,
    hasSocialLinks: false,
  };
  for (const block of blocks) {
    switch (block.type) {
      case "row":
        inventory.columnCountsPerRow.push(block.childrenIds.length);
        break;
      case "image": {
        inventory.imageCount += 1;
        if (/logo/i.test(block.properties.alt) || /logo/i.test(block.properties.src)) {
          inventory.hasLogoImage = true;
        }
        break;
      }
      case "button":
        inventory.buttonLabels.push(block.properties.label);
        break;
      case "link": {
        inventory.standaloneLinkCount += 1;
        const linkText = `${block.properties.text} ${block.properties.href}`;
        if (/unsubscribe/i.test(linkText)) {
          inventory.hasUnsubscribeText = true;
        }
        if (SOCIAL_HOST_REGEX.test(linkText)) {
          inventory.hasSocialLinks = true;
        }
        break;
      }
      case "text": {
        const flatText = flattenTextBlock(block);
        for (const node of block.properties.text.content) {
          if (node.type === "heading") {
            const headingText = (node.content ?? [])
              .map((run) => (run.type === "text" ? run.text : " "))
              .join("")
              .trim();
            if (headingText.length > 0) {
              inventory.headingTexts.push(headingText);
            }
          } else {
            inventory.paragraphCount += 1;
          }
        }
        if (/unsubscribe/i.test(flatText)) {
          inventory.hasUnsubscribeText = true;
        }
        if (/©|\(c\)|rights reserved|privacy|terms/i.test(flatText)) {
          inventory.hasLegalText = true;
        }
        if (SOCIAL_HOST_REGEX.test(flatText)) {
          inventory.hasSocialLinks = true;
        }
        break;
      }
      default:
        break;
    }
  }
  return inventory;
}

function describeLayout(inventory: SectionInventory): string {
  if (inventory.columnCountsPerRow.length === 0) {
    return "A stacked single-column section";
  }
  const columnPhrases = inventory.columnCountsPerRow.map(
    (columnCount) => `${columnCount}-column`,
  );
  return `A section with ${columnPhrases.length === 1 ? `a ${columnPhrases[0]} row` : `${columnPhrases.length} rows (${columnPhrases.join(", ")})`}`;
}

function describeInventory(inventory: SectionInventory): string[] {
  const parts: string[] = [];
  if (inventory.hasLogoImage) {
    parts.push("a logo image");
  }
  const plainImageCount = inventory.imageCount - (inventory.hasLogoImage ? 1 : 0);
  if (plainImageCount > 0) {
    parts.push(plainImageCount === 1 ? "an image" : `${plainImageCount} images`);
  }
  if (inventory.headingTexts.length > 0) {
    parts.push(`a heading ("${inventory.headingTexts[0]}")`);
  }
  if (inventory.paragraphCount > 0) {
    parts.push(inventory.paragraphCount === 1 ? "body text" : "several paragraphs");
  }
  if (inventory.buttonLabels.length > 0) {
    parts.push(
      inventory.buttonLabels.length === 1
        ? `a "${inventory.buttonLabels[0]}" button`
        : `${inventory.buttonLabels.length} buttons`,
    );
  }
  if (inventory.hasSocialLinks) {
    parts.push("social profile links");
  }
  if (inventory.hasUnsubscribeText || inventory.hasLegalText) {
    parts.push("legal/unsubscribe details");
  }
  if (parts.length === 0 && inventory.standaloneLinkCount > 0) {
    parts.push(
      inventory.standaloneLinkCount === 1
        ? "a standalone link"
        : `${inventory.standaloneLinkCount} standalone links`,
    );
  }
  return parts;
}

/**
 * The quota-free enrichment floor: genre is inferred from footer/header
 * signals, everything else reads straight off the inventory. Deliberately
 * conservative prose — concrete inventory, no invented purpose.
 */
export function buildDeterministicEnrichment(blocks: readonly Block[]): SavedSectionEnrichment {
  const inventory = analyzeSectionSubtree(blocks);
  const inventoryParts = describeInventory(inventory);
  const description =
    `${describeLayout(inventory)}${inventoryParts.length > 0 ? ` containing ${inventoryParts.join(", ")}` : ""}.`;

  const isFooterLike = inventory.hasUnsubscribeText || inventory.hasLegalText;
  const isHeaderLike =
    !isFooterLike && inventory.hasLogoImage && inventory.buttonLabels.length === 0;
  let useWhen: string;
  if (isFooterLike) {
    useWhen =
      "Use as the email's closing footer — it already carries the user's real legal, unsubscribe, and link details.";
  } else if (isHeaderLike) {
    useWhen = "Use as the branded header block at the top of the email.";
  } else if (inventory.headingTexts.length > 0 && inventory.buttonLabels.length > 0) {
    useWhen = `Use for a featured announcement or story block with a call to action (like "${inventory.headingTexts[0]}").`;
  } else {
    useWhen = "Use when the email needs this saved layout with the user's own content again.";
  }
  return { useWhen, description };
}
