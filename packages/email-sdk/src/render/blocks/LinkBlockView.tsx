import { Column, Link, Row } from "react-email";
import type { LinkBlock } from "../../schema/blocks";
import type { ResolvedLinkStyles } from "../styles";
import { blockPaddingStyle } from "./shared";

export interface LinkBlockViewProps {
  block: LinkBlock;
  resolvedStyles: ResolvedLinkStyles;
}

/**
 * link → React Email <Link> (a plain anchor with inline styles) on its own
 * line. Color falls back to globals.linkTextColor and the font to the
 * paragraph global, so standalone links match inline text links by default;
 * `align` is applied as text-align on the wrapping cell, like the button.
 */
export function LinkBlockView({ block, resolvedStyles }: LinkBlockViewProps) {
  return (
    <Row>
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
