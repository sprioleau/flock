import { Column, Hr, Row } from "react-email";
import type { DividerBlock } from "../../schema/blocks";
import type { ResolvedDividerStyles } from "../styles";
import { blockPaddingStyle } from "./shared";

export interface DividerBlockViewProps {
  block: DividerBlock;
  resolvedStyles: ResolvedDividerStyles;
}

/** divider → React Email <Hr>, drawn as a border-top of the resolved color. */
export function DividerBlockView({ resolvedStyles }: DividerBlockViewProps) {
  return (
    <Row>
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
