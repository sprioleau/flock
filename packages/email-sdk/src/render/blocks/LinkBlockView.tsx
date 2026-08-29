import { Column, Link, Row } from "react-email";
import type { LinkBlock } from "../../schema/blocks";
import type { ResolvedLinkStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface LinkBlockViewProps {
  block: LinkBlock;
  resolvedStyles: ResolvedLinkStyles;
  /**
   * Analysis-only stamp carrying this block's id onto the outermost element.
   * Empty (and therefore absent from the HTML) on every ordinary render —
   * see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
   */
  annotation?: BlockAnnotation;
}

/**
 * link → React Email <Link> (a plain anchor with inline styles) on its own
 * line. Color falls back to globals.linkTextColor and the font to the
 * paragraph global, so standalone links match inline text links by default;
 * `align` is applied as text-align on the wrapping cell, like the button.
 */
export function LinkBlockView({ block, resolvedStyles, annotation = {} }: LinkBlockViewProps) {
  return (
    <Row {...annotation}>
      <Column style={{ ...blockPaddingStyle(resolvedStyles), textAlign: resolvedStyles.align }}>
        <Link
          href={block.properties.href}
          style={{
            color: resolvedStyles.textColor,
            fontFamily: resolvedStyles.fontFamily,
            fontSize: `${resolvedStyles.fontSize}px`,
            textDecoration: resolvedStyles.isUnderlined ? "underline" : "none",
          }}
        >
          {block.properties.text}
        </Link>
      </Column>
    </Row>
  );
}
