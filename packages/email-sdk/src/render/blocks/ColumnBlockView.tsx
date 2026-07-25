import type { ReactNode } from "react";
import { Column } from "react-email";
import type { ColumnBlock } from "../../schema/blocks";
import type { ResolvedColumnStyles } from "../styles";
import { blockPaddingStyle } from "./shared";

export interface ColumnBlockViewProps {
  block: ColumnBlock;
  resolvedStyles: ResolvedColumnStyles;
  children?: ReactNode;
}

/** column → React Email <Column> (a td). Width omitted = equal share of the row. */
export function ColumnBlockView({ resolvedStyles, children }: ColumnBlockViewProps) {
  return (
    <Column
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
