import { Button, Column, Row } from "react-email";
import type { ButtonBlock } from "../../schema/blocks";
import type { ResolvedButtonStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface ButtonBlockViewProps {
  block: ButtonBlock;
  resolvedStyles: ResolvedButtonStyles;
  /*
    Analysis-only stamp carrying this block's id onto the outermost element.
    Empty (and therefore absent from the HTML) on every ordinary render —
    see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
  */
  annotation?: BlockAnnotation;
}

/*
  button → React Email <Button> (an inline-block anchor with MSO padding
  hacks). Inner padding goes through the style `padding` shorthand, which
  React Email parses to generate Outlook-safe spacing; `align` is applied as
  text-align on the wrapping cell.
*/
export function ButtonBlockView({ block, resolvedStyles, annotation = {} }: ButtonBlockViewProps) {
  const hasBorder = resolvedStyles.borderSize > 0 && resolvedStyles.borderStyle !== "none";
  return (
    <Row {...annotation}>
      <Column style={{ ...blockPaddingStyle(resolvedStyles), textAlign: resolvedStyles.align }}>
        <Button
          href={block.properties.href}
          style={{
            backgroundColor: resolvedStyles.backgroundColor,
            color: resolvedStyles.textColor,
            borderRadius: `${resolvedStyles.borderRadius}px`,
            ...(hasBorder
              ? {
                  border: `${resolvedStyles.borderSize}px ${resolvedStyles.borderStyle} ${resolvedStyles.borderColor}`,
                }
              : {}),
            padding: `${resolvedStyles.verticalPadding}px ${resolvedStyles.horizontalPadding}px`,
            fontFamily: resolvedStyles.fontFamily,
          }}
        >
          {block.properties.label}
        </Button>
      </Column>
    </Row>
  );
}
