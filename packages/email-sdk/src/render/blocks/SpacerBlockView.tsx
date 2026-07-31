import { Column, Row } from "react-email";
import type { SpacerBlock } from "../../schema/blocks";
import type { ResolvedSpacerStyles } from "../styles";

export interface SpacerBlockViewProps {
  block: SpacerBlock;
  resolvedStyles: ResolvedSpacerStyles;
}

/**
 * spacer → the email-safe fixed-height idiom: a table cell with an explicit
 * height, a 1px font, and a line-height pinned to the same height so no
 * client (Outlook especially) collapses or inflates it. The single &nbsp;
 * keeps clients that drop empty cells from removing the row. Transparent —
 * the container background shows through.
 */
export function SpacerBlockView({ resolvedStyles }: SpacerBlockViewProps) {
  const { height } = resolvedStyles;
  return (
    <Row>
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
