import type { FunctionReturnType } from "convex/server";
import type { Block, BlockId, BlockType, EmailDocument } from "@flock/email-sdk";
import type { api } from "@convex/_generated/api";
import { getAncestorIds } from "@/lib/get-ancestor-ids";

/**
 * Comments mode — the pure anchoring/context half (no React, no Convex
 * client): what a canvas click resolves to, and the denormalized context a
 * comment freezes at creation so its thread stays readable after the anchor
 * block (or the whole draft layout) changes.
 */

/** One comment thread row as served by convex/comments.ts queries. */
export type CommentThread = FunctionReturnType<
  typeof api.comments.listCommentsForCanvas
>[number];

/** The pointer-presence coordinate model, reused verbatim (see the schema note). */
export interface CommentAnchor {
  blockId: string | null;
  x: number;
  y: number;
}

/** The client-authored slice of a comment's frozen placement context. */
export interface CommentAnchorContext {
  /** "Section › Row › Column › Button" — "" for a draft-level comment. */
  breadcrumb: string;
  blockType?: string;
  textSnippet?: string;
}

/**
 * User-facing type labels — same vocabulary as the selection breadcrumb
 * (BlockBreadcrumb.tsx): full words, never ids.
 */
const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  root: "Email",
  section: "Section",
  row: "Row",
  column: "Column",
  text: "Text",
  button: "Button",
  image: "Image",
  divider: "Divider",
  link: "Link",
  code: "Code",
  spacer: "Spacer",
};

/** Longest visible-text snippet stored/shown per comment (server re-caps at 160). */
const MAX_SNIPPET_CHARS = 80;

/**
 * The block's visible text, for the "which block was this about" cue that
 * outlives the block: rich-text first non-empty node, button label, link
 * text, image alt. Undefined for structural/visual blocks (divider, spacer,
 * code, containers) — the breadcrumb carries them.
 */
export function extractBlockTextSnippet(block: Block): string | undefined {
  const rawText = (() => {
    switch (block.type) {
      case "text": {
        for (const node of block.properties.text.content) {
          const nodeText = (node.content ?? [])
            .map((run) => (run.type === "text" ? run.text : " "))
            .join("")
            .trim();
          if (nodeText.length > 0) {
            return nodeText;
          }
        }
        return "";
      }
      case "button":
        return block.properties.label;
      case "link":
        return block.properties.text;
      case "image":
        return block.properties.alt;
      default:
        return "";
    }
  })().trim();
  if (rawText.length === 0) {
    return undefined;
  }
  return rawText.length > MAX_SNIPPET_CHARS
    ? `${rawText.slice(0, MAX_SNIPPET_CHARS - 1)}…`
    : rawText;
}

/**
 * The frozen placement context for a block-anchored comment: ancestor trail
 * (root excluded, outermost first) plus the block's own label, and its
 * visible text. Null when the block is not in the doc (the caller then
 * anchors to the draft instead).
 */
export function buildCommentAnchorContext({
  doc,
  blockId,
}: {
  doc: EmailDocument;
  blockId: BlockId;
}): CommentAnchorContext | null {
  const block = doc[blockId];
  if (block === undefined) {
    return null;
  }
  const trailIds = [...getAncestorIds({ doc, blockId }), blockId];
  const breadcrumb = trailIds
    .map((trailId) => {
      const trailType = doc[trailId]?.type;
      return trailType !== undefined ? BLOCK_TYPE_LABELS[trailType] : null;
    })
    .filter((label): label is string => label !== null)
    .join(" › ");
  const textSnippet = extractBlockTextSnippet(block);
  return {
    breadcrumb,
    blockType: BLOCK_TYPE_LABELS[block.type],
    ...(textSnippet !== undefined ? { textSnippet } : {}),
  };
}

/**
 * ORPHANED = the comment was anchored to a block that no longer exists in
 * the rendered doc. Derived, never stored: it converges from the document
 * itself in every tab (and un-orphans for free if an undo restores the
 * block). Draft-level comments can't orphan.
 */
export function getIsCommentOrphaned({
  comment,
  doc,
}: {
  comment: Pick<CommentThread, "anchor">;
  doc: EmailDocument;
}): boolean {
  return comment.anchor.blockId !== null && doc[comment.anchor.blockId as BlockId] === undefined;
}

/** Clamp to the anchor rect and round to ~0.1% (usePointerPresence's fraction contract). */
export function toAnchorFraction({
  pointerCoordinate,
  rectStart,
  rectSize,
}: {
  pointerCoordinate: number;
  rectStart: number;
  rectSize: number;
}): number {
  const fraction = (pointerCoordinate - rectStart) / rectSize;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 1000;
}
