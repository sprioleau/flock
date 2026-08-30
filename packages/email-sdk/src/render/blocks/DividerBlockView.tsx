import { Column, Hr, Row } from "react-email";
import type { DividerBlock } from "../../schema/blocks";
import type { ResolvedDividerStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface DividerBlockViewProps {
  block: DividerBlock;
  resolvedStyles: ResolvedDividerStyles;
  /*
    Analysis-only stamp carrying this block's id onto the outermost element.
    Empty (and therefore absent from the HTML) on every ordinary render —
    see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
  */
  annotation?: BlockAnnotation;
}

/*
  divider → React Email <Hr>, drawn as a border-top of the resolved color.
*/
export function DividerBlockView({ resolvedStyles, annotation = {} }: DividerBlockViewProps) {
  return (
    <Row {...annotation}>
      <Column style={blockPaddingStyle(resolvedStyles)}>
        <Hr
          style={{
            borderTop: `${resolvedStyles.thickness}px solid ${resolvedStyles.color}`,
            margin: 0,
          }}
        />
      </Column>
    </Row>
  );
}
