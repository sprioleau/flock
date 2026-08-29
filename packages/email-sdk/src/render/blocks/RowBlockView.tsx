import type { ReactNode } from "react";
import { Row } from "react-email";
import type { RowBlock } from "../../schema/blocks";
import type { ResolvedRowStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface RowBlockViewProps {
  block: RowBlock;
  resolvedStyles: ResolvedRowStyles;
  children?: ReactNode;
  /**
   * Analysis-only stamp carrying this block's id onto the outermost element.
   * Empty (and therefore absent from the HTML) on every ordinary render —
   * see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
   */
  annotation?: BlockAnnotation;
}

/**
 * row → React Email <Row>. Children must be ColumnBlockViews (td cells).
 *
 * Row padding and background live on a wrapping table cell, not the <Row>
 * table itself: <Row> renders a border-collapsed table, and collapsed tables
 * ignore padding (both in browsers and email clients). A <td> is the one
 * surface every client honors for BOTH padding and background-color — the
 * same trick React Email's Section uses internally, and the same surface the
 * column, text, and image blocks paint their own backgrounds on.
 *
 * The wrapper is emitted ONLY when the row actually carries padding or a
 * background, so an unstyled row still renders the bare <Row> markup it
 * always has (the golden snapshots are the proof).
 */
export function RowBlockView({ resolvedStyles, children, annotation = {} }: RowBlockViewProps) {
  const { paddingTop, paddingBottom, paddingLeft, paddingRight, backgroundColor } = resolvedStyles;
  const hasPadding = paddingTop > 0 || paddingBottom > 0 || paddingLeft > 0 || paddingRight > 0;
  const row = <Row>{children}</Row>;

  if (!hasPadding && backgroundColor === undefined) {
    /* No wrapper cell: the bare <Row> IS the outermost element, so it wears
       the stamp. */
    return <Row {...annotation}>{children}</Row>;
  }

  return (
    <table
      {...annotation}
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
              ...blockPaddingStyle(resolvedStyles),
              ...(backgroundColor === undefined ? {} : { backgroundColor }),
            }}
          >
            {row}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
