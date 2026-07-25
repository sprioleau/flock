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
