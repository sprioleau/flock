import { CodeBlock as ReactEmailCodeBlock, Column, oneDark, oneLight, Row } from "react-email";
import type { CodeBlock } from "../../schema/blocks";
import type { ResolvedCodeStyles } from "../styles";
import { blockPaddingStyle } from "./shared";

export interface CodeBlockViewProps {
  block: CodeBlock;
  resolvedStyles: ResolvedCodeStyles;
}

/**
 * The intent-level theme names the schema exposes ("light" / "dark") map
 * deterministically to React Email's Prism themes here — the model and the
 * property panel never see raw Prism style objects.
 */
const PRISM_THEMES_BY_NAME = { light: oneLight, dark: oneDark } as const;

/**
 * code → React Email <CodeBlock>: Prism syntax highlighting rendered as a
 * <pre> of spans with inline, email-safe styles (no stylesheets, no script).
 * The theme's own base padding/background stay as designed; outer spacing
 * comes from block padding like every other leaf.
 */
export function CodeBlockView({ block, resolvedStyles }: CodeBlockViewProps) {
  return (
    <Row>
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
