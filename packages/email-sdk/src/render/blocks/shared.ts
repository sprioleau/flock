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
