import { Column, Row } from "react-email";
import type { SpacerBlock } from "../../schema/blocks";
import type { ResolvedSpacerStyles } from "../styles";
import type { BlockAnnotation } from "./shared";

export interface SpacerBlockViewProps {
  block: SpacerBlock;
  resolvedStyles: ResolvedSpacerStyles;
  /**
   * Analysis-only stamp carrying this block's id onto the outermost element.
   * Empty (and therefore absent from the HTML) on every ordinary render —
   * see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
   */
  annotation?: BlockAnnotation;
}

/**
 * spacer → the email-safe fixed-height idiom: a table cell with an explicit
 * height, a 1px font, and a line-height pinned to the same height so no
 * client (Outlook especially) collapses or inflates it. The single &nbsp;
 * keeps clients that drop empty cells from removing the row. Transparent —
 * the container background shows through.
 */
export function SpacerBlockView({ resolvedStyles, annotation = {} }: SpacerBlockViewProps) {
  const { height } = resolvedStyles;
  return (
    <Row {...annotation}>
      <Column
        style={{
          height: `${height}px`,
          fontSize: "1px",
          lineHeight: `${height}px`,
        }}
      >
        {" "}
      </Column>
    </Row>
  );
}
