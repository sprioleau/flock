import { CodeBlock as ReactEmailCodeBlock, Column, oneDark, oneLight, Row } from "react-email";
import type { CodeBlock } from "../../schema/blocks";
import type { ResolvedCodeStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface CodeBlockViewProps {
  block: CodeBlock;
  resolvedStyles: ResolvedCodeStyles;
  /*
    Analysis-only stamp carrying this block's id onto the outermost element.
    Empty (and therefore absent from the HTML) on every ordinary render —
    see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
  */
  annotation?: BlockAnnotation;
}

/*
  The intent-level theme names the schema exposes ("light" / "dark") map
  deterministically to React Email's Prism themes here — the model and the
  property panel never see raw Prism style objects.
*/
const PRISM_THEMES_BY_NAME = { light: oneLight, dark: oneDark } as const;

/*
  code → React Email <CodeBlock>: Prism syntax highlighting rendered as a
  <pre> of spans with inline, email-safe styles (no stylesheets, no script).
  The theme's own base padding/background stay as designed; outer spacing
  comes from block padding like every other leaf.
*/
export function CodeBlockView({ block, resolvedStyles, annotation = {} }: CodeBlockViewProps) {
  return (
    <Row {...annotation}>
      <Column style={blockPaddingStyle(resolvedStyles)}>
        <ReactEmailCodeBlock
          code={block.properties.code}
          language={block.properties.language}
          theme={PRISM_THEMES_BY_NAME[resolvedStyles.theme]}
          lineNumbers={resolvedStyles.shouldShowLineNumbers}
          style={{ margin: 0 }}
        />
      </Column>
    </Row>
  );
}
