import type { ReactNode } from "react";
import { Row } from "react-email";
import type { RowBlock } from "../../schema/blocks";
import type { ResolvedRowStyles } from "../styles";

export interface RowBlockViewProps {
  block: RowBlock;
  resolvedStyles: ResolvedRowStyles;
  children?: ReactNode;
}

/** row → React Email <Row>. Children must be ColumnBlockViews (td cells). */
export function RowBlockView({ resolvedStyles, children }: RowBlockViewProps) {
  return (
    <Row
      style={{
        paddingTop: `${resolvedStyles.paddingTop}px`,
        paddingBottom: `${resolvedStyles.paddingBottom}px`,
      }}
    >
      {children}
    </Row>
  );
}
