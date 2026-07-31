/**
 * "Fill from brand kit" — footer social-row sync (item 26, part 3).
 *
 * Chosen semantics (documented for the owner): NOT a persistent auto-sync
 * switch. Silent restyling on kit changes is against the repo's explicit-ops
 * philosophy (every content change is a deliberate, attributable, undoable
 * act — same reasoning as the brand-propagation prompt in the brand-kit
 * architecture proposal). Instead:
 *
 * 1. The SECTION panel shows a "Fill from brand kit" affordance whenever the
 *    selected section CONTAINS a social row (link-marked text runs or link
 *    blocks pointing at known social platforms) and the active kit has
 *    social links. Clicking rebuilds the social row from the kit — ordinary
 *    user-authored ops, undoable, nothing synced behind the user's back.
 * 2. Inserting the social footer template from the gallery defaults its
 *    social links to the brand kit's (apply-on-insert, on by default) — the
 *    insertion itself is the deliberate act there.
 *
 * Pure module: detection + update-building only; the panel dispatches.
 */

import type { Block, BlockId, EmailDocument, TextMark, TextNode } from "@tandem/email-sdk";
import {
  classifySocialUrl,
  SOCIAL_PLATFORM_LABELS,
  type BrandSocialLink,
} from "./social-links";

/** Loose structural view of a rich-text doc (guarded reads only). */
interface RichTextDoc {
  type: "doc";
  content?: RichTextTopNode[];
}
interface RichTextTopNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TextNode[];
}

const DEFAULT_SEPARATOR = "   ·   ";

function getLinkHref(node: TextNode): string | null {
  const linkMark = node.marks?.find((mark) => mark.type === "link");
  if (linkMark === undefined || linkMark.type !== "link") {
    return null;
  }
  return linkMark.attrs.href;
}

function isSocialLinkRun(node: TextNode): boolean {
  const href = getLinkHref(node);
  return href !== null && classifySocialUrl(href) !== null;
}

/** A paragraph is a "social row" when it contains ≥1 social link run. */
function isSocialParagraph(node: RichTextTopNode): boolean {
  return (
    node.type === "paragraph" &&
    (node.content ?? []).some((child) => child.type === "text" && isSocialLinkRun(child))
  );
}

function getBlockTextDoc(block: Block): RichTextDoc | null {
  const text = (block.properties as { text?: unknown }).text;
  if (typeof text !== "object" || text === null || (text as { type?: string }).type !== "doc") {
    return null;
  }
  return text as RichTextDoc;
}

/** One buildable update: a merge-patch for one block. */
export interface SocialFillUpdate {
  blockId: BlockId;
  properties: Record<string, unknown>;
}

/** Every block id in the section's subtree, depth-first. */
function collectSubtreeBlocks(doc: EmailDocument, sectionId: BlockId): Block[] {
  const blocks: Block[] = [];
  const walk = (blockId: BlockId): void => {
    const block = doc[blockId];
    if (block === undefined) {
      return;
    }
    blocks.push(block);
    for (const childId of block.childrenIds) {
      walk(childId);
    }
  };
  walk(sectionId);
  return blocks;
}

/** True when the section contains a fillable social row (drives the affordance). */
export function hasSocialRow({
  doc,
  sectionId,
}: {
  doc: EmailDocument;
  sectionId: BlockId;
}): boolean {
  return collectSubtreeBlocks(doc, sectionId).some((block) => {
    if (block.type === "link") {
      const href = (block.properties as { href?: unknown }).href;
      return typeof href === "string" && classifySocialUrl(href) !== null;
    }
    if (block.type === "text") {
      const textDoc = getBlockTextDoc(block);
      return textDoc !== null && (textDoc.content ?? []).some(isSocialParagraph);
    }
    return false;
  });
}

/**
 * Rebuild one social paragraph's runs from the kit links: every kit platform,
 * in kit order, joined by the paragraph's ORIGINAL separator text and
 * carrying the original link runs' non-link marks (font size etc.) so the
 * row keeps its styling.
 */
function rebuildSocialParagraph(
  paragraph: RichTextTopNode,
  socialLinks: BrandSocialLink[],
): RichTextTopNode {
  const children = paragraph.content ?? [];
  const firstSocialRun = children.find((child) => child.type === "text" && isSocialLinkRun(child));
  const templateMarks: TextMark[] = (firstSocialRun?.marks ?? []).filter(
    (mark) => mark.type !== "link",
  );
  // The original separator: the first non-link text run BETWEEN runs.
  const separatorRun = children.find(
    (child, index) =>
      index > 0 && index < children.length - 1 && child.type === "text" && getLinkHref(child) === null,
  );
  const separatorText = separatorRun?.type === "text" ? separatorRun.text : DEFAULT_SEPARATOR;

  const runs: TextNode[] = socialLinks.flatMap((link, index) => {
    const linkRun: TextNode = {
      type: "text",
      text: SOCIAL_PLATFORM_LABELS[link.platform],
      marks: [...templateMarks, { type: "link", attrs: { href: link.url } }],
    };
    if (index === 0) {
      return [linkRun];
    }
    const separator: TextNode = {
      type: "text",
      text: separatorText,
      ...(templateMarks.length > 0 ? { marks: templateMarks } : {}),
    };
    return [separator, linkRun];
  });
  return { ...paragraph, content: runs };
}

/**
 * Build the property updates that sync the section's social row(s) to the
 * kit: social paragraphs are rebuilt wholesale from the kit list; standalone
 * social LINK BLOCKS are updated in place only when the kit has the same
 * platform (a mismatched platform is left for the user — no destructive
 * surprise). Returns [] when there is nothing to do.
 */
export function buildSocialFillUpdates({
  doc,
  sectionId,
  socialLinks,
}: {
  doc: EmailDocument;
  sectionId: BlockId;
  socialLinks: BrandSocialLink[];
}): SocialFillUpdate[] {
  if (socialLinks.length === 0) {
    return [];
  }
  const updates: SocialFillUpdate[] = [];
  for (const block of collectSubtreeBlocks(doc, sectionId)) {
    if (block.type === "text") {
      const textDoc = getBlockTextDoc(block);
      if (textDoc === null || !(textDoc.content ?? []).some(isSocialParagraph)) {
        continue;
      }
      const nextContent = (textDoc.content ?? []).map((node) =>
        isSocialParagraph(node) ? rebuildSocialParagraph(node, socialLinks) : node,
      );
      updates.push({
        blockId: block.id,
        properties: { text: { ...textDoc, content: nextContent } },
      });
    } else if (block.type === "link") {
      const href = (block.properties as { href?: unknown }).href;
      const classified = typeof href === "string" ? classifySocialUrl(href) : null;
      if (classified === null) {
        continue;
      }
      const kitLink = socialLinks.find(({ platform }) => platform === classified.platform);
      if (kitLink !== undefined && kitLink.url !== href) {
        updates.push({
          blockId: block.id,
          properties: { href: kitLink.url, text: SOCIAL_PLATFORM_LABELS[kitLink.platform] },
        });
      }
    }
  }
  return updates;
}
