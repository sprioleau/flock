import type { ReactNode } from "react";
import { Row } from "react-email";
import type { RowBlock } from "../../schema/blocks";
import type { ResolvedRowStyles } from "../styles";

export interface RowBlockViewProps {
  block: RowBlock;
  resolvedStyles: ResolvedRowStyles;
  children?: ReactNode;
}

/**
 * row → React Email <Row>. Children must be ColumnBlockViews (td cells).
 *
 * Row padding lives on a wrapping table cell, not the <Row> table itself:
 * <Row> renders a border-collapsed table, and collapsed tables ignore
 * padding (both in browsers and email clients). Padding on a <td> is the
 * one spacing primitive every client honors — the same trick React Email's
 * Section uses internally.
 */
export function RowBlockView({ resolvedStyles, children }: RowBlockViewProps) {
  const hasVerticalPadding = resolvedStyles.paddingTop > 0 || resolvedStyles.paddingBottom > 0;
  const row = <Row>{children}</Row>;

  if (!hasVerticalPadding) {
    return row;
  }

  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={0}
      style={{ borderCollapse: "collapse" }}
    >
      <tbody>
        <tr>
          <td
            style={{
              paddingTop: `${resolvedStyles.paddingTop}px`,
              paddingBottom: `${resolvedStyles.paddingBottom}px`,
            }}
          >
            {row}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
