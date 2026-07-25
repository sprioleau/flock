import type { ReactNode } from "react";
import { Container, Section } from "react-email";
import type { SectionBlock } from "../../schema/blocks";
import type { ResolvedSectionStyles } from "../styles";
import { blockPaddingStyle } from "./shared";

export interface SectionBlockViewProps {
  block: SectionBlock;
  resolvedStyles: ResolvedSectionStyles;
  children?: ReactNode;
}

/**
 * section → React Email <Section> (a full-width band carrying
 * outerBackgroundColor) wrapping a <Container> (the centered content area of
 * globals.contentWidth carrying innerBackgroundColor and the section
 * padding). The per-section Container is what makes outerBackgroundColor
 * renderable as a full-bleed band on wide clients.
 */
export function SectionBlockView({ resolvedStyles, children }: SectionBlockViewProps) {
  return (
    <Section style={{ backgroundColor: resolvedStyles.outerBackgroundColor }}>
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
