import type { CSSProperties } from "react";
import type { ResolvedPadding } from "../styles";

/** Resolved numeric padding → inline-style pixel values. */
export function blockPaddingStyle(padding: ResolvedPadding): CSSProperties {
  return {
    paddingTop: `${padding.paddingTop}px`,
    paddingBottom: `${padding.paddingBottom}px`,
    paddingLeft: `${padding.paddingLeft}px`,
    paddingRight: `${padding.paddingRight}px`,
  };
}

/**
 * Renderer constants for heading typography, shared by the text block's
 * heading nodes and the standalone heading block. The globals carry per-level
 * font/color/alignment; sizes are fixed here for cross-client consistency
 * (email clients disagree on default hN sizes).
 */
export const HEADING_FONT_SIZES = { 1: "32px", 2: "24px", 3: "20px" } as const;

/**
 * ANALYSIS-ONLY BLOCK MARKING.
 *
 * The pre-send compatibility check (src/qa) asks a question about HTML —
 * "does `border-radius` work in Outlook?" — and has to answer it in terms of
 * BLOCKS, because a block id is the only thing the findings UI can point at.
 * Nothing in the rendered email carries that correspondence: the renderer
 * uses `block.id` as a React `key`, and a key is not an attribute, so the
 * HTML that leaves `renderToHTML` has no trace of which block produced which
 * markup. Reconstructing it by matching text or styles would be guesswork,
 * and a finding attached to the wrong block is worse than one attached to
 * nothing.
 *
 * So each view can be asked to stamp its OUTERMOST element with the id of
 * the block it is rendering, and the checker walks outward from an issue's
 * position to the nearest stamped ancestor.
 *
 * OFF BY DEFAULT, AND NEVER ON THE SENT EMAIL. The annotation exists for the
 * second, throwaway render the checker performs; the render that becomes the
 * message is byte-for-byte what it was before this existed (the golden
 * snapshots are the proof — they are taken without annotation and did not
 * move). That costs one extra render per check and buys a guarantee that no
 * analysis feature can ever add a byte to what a subscriber receives.
 *
 * The attribute is inert with respect to the checker itself: caniemail keys
 * its element and attribute checks off the caniemail dataset, which has no
 * entry for `data-*`, so annotating changes no finding. That is asserted in
 * qa/check-compatibility.test.ts rather than assumed.
 */
export const BLOCK_ANNOTATION_ATTRIBUTE = "data-flock-block-id";

/**
 * The stamp itself, spread onto a view's outermost element. Empty when the
 * render is not annotated, which is the ordinary case.
 */
export interface BlockAnnotation {
  "data-flock-block-id"?: string;
}

/** Build the stamp for a block, or nothing at all when annotation is off. */
export function buildBlockAnnotation(blockId: string | undefined): BlockAnnotation {
  return blockId === undefined ? {} : { "data-flock-block-id": blockId };
}
