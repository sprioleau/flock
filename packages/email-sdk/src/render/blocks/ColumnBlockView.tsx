import type { ReactNode } from "react";
import { Column } from "react-email";
import type { ColumnBlock } from "../../schema/blocks";
import type { ResolvedColumnStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface ColumnBlockViewProps {
  block: ColumnBlock;
  resolvedStyles: ResolvedColumnStyles;
  children?: ReactNode;
  /**
   * Analysis-only stamp carrying this block's id onto the outermost element.
   * Empty (and therefore absent from the HTML) on every ordinary render —
   * see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
   */
  annotation?: BlockAnnotation;
}

/** column → React Email <Column> (a td). Width omitted = equal share of the row. */
export function ColumnBlockView({ resolvedStyles, children, annotation = {} }: ColumnBlockViewProps) {
  return (
    <Column
      {...annotation}
      style={{
        ...(resolvedStyles.widthPercent !== undefined
          ? { width: `${resolvedStyles.widthPercent}%` }
          : {}),
        verticalAlign: resolvedStyles.verticalAlign,
        ...(resolvedStyles.backgroundColor !== undefined
          ? { backgroundColor: resolvedStyles.backgroundColor }
          : {}),
        ...blockPaddingStyle(resolvedStyles),
      }}
    >
      {children}
    </Column>
  );
}
