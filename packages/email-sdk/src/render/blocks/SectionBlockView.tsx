import type { ReactNode } from "react";
import { Container, Section } from "react-email";
import type { SectionBlock } from "../../schema/blocks";
import type { ResolvedSectionStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface SectionBlockViewProps {
  block: SectionBlock;
  resolvedStyles: ResolvedSectionStyles;
  children?: ReactNode;
  /*
    Analysis-only stamp carrying this block's id onto the outermost element.
    Empty (and therefore absent from the HTML) on every ordinary render —
    see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
  */
  annotation?: BlockAnnotation;
}

/*
  section → React Email <Section> (a full-width band carrying
  outerBackgroundColor) wrapping a <Container> (the centered content area of
  globals.contentWidth carrying innerBackgroundColor and the section
  padding). The per-section Container is what makes outerBackgroundColor
  renderable as a full-bleed band on wide clients.
*/
export function SectionBlockView({ resolvedStyles, children, annotation = {} }: SectionBlockViewProps) {
  return (
    <Section {...annotation} style={{ backgroundColor: resolvedStyles.outerBackgroundColor }}>
      <Container
        style={{
          width: "100%",
          maxWidth: `${resolvedStyles.contentWidth}px`,
          backgroundColor: resolvedStyles.innerBackgroundColor,
          ...blockPaddingStyle(resolvedStyles),
        }}
      >
        {children}
      </Container>
    </Section>
  );
}
