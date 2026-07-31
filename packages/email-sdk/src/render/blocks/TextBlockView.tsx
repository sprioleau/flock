import { Fragment, type ReactNode } from "react";
import { Column, Heading, Link, Row, Text } from "react-email";
import type { TextBlock } from "../../schema/blocks";
import type { TextAlign } from "../../schema/globals";
import type { InlineNode, TextMark, TextNode } from "../../schema/text";
import type { ResolvedTextNodeStyles, ResolvedTextStyles } from "../styles";
import { blockPaddingStyle, HEADING_FONT_SIZES } from "./shared";

export interface TextBlockViewProps {
  block: TextBlock;
  resolvedStyles: ResolvedTextStyles;
}

/**
 * Wrap a text run in email-safe inline elements, innermost-first in mark
 * order: bold → <strong>, italic → <em>, underline/strike → styled <span>
 * (text-decoration inherits through nesting, so both can apply), link →
 * <Link> colored by globals.linkTextColor, textStyle → <span> carrying the
 * span-level typography (font-family / color / font-size) as plain inline
 * CSS, highlight → <span> with an inline background-color. Everything stays
 * on span/anchor elements with inline styles only — the email-safe subset.
 */
function applyMarks(node: TextNode, linkTextColor: string): ReactNode {
  return (node.marks ?? []).reduce<ReactNode>((content, mark: TextMark) => {
    switch (mark.type) {
      case "bold":
        return <strong>{content}</strong>;
      case "italic":
        return <em>{content}</em>;
      case "underline":
        return <span style={{ textDecoration: "underline" }}>{content}</span>;
      case "strike":
        return <span style={{ textDecoration: "line-through" }}>{content}</span>;
      case "textStyle": {
        const { fontFamily, color, fontSize } = mark.attrs;
        return (
          <span
            style={{
              ...(fontFamily !== undefined ? { fontFamily } : {}),
              ...(color !== undefined ? { color } : {}),
              ...(fontSize !== undefined ? { fontSize } : {}),
            }}
          >
            {content}
          </span>
        );
      }
      case "highlight":
        return <span style={{ backgroundColor: mark.attrs.color }}>{content}</span>;
      case "link":
        return (
          <Link
            href={mark.attrs.href}
            style={{ color: linkTextColor, textDecoration: "underline" }}
          >
            {content}
          </Link>
        );
    }
  }, node.text);
}

function renderInlineNodes(
  nodes: InlineNode[] | undefined,
  linkTextColor: string,
): ReactNode[] {
  return (nodes ?? []).map((node, index) =>
    node.type === "hardBreak" ? (
      <br key={index} />
    ) : (
      <Fragment key={index}>{applyMarks(node, linkTextColor)}</Fragment>
    ),
  );
}

/**
 * text → the block's TextDoc walked node by node: heading nodes →
 * <Heading as={h1|h2|h3}> styled from the level-matching heading globals,
 * paragraphs → <Text> styled from the paragraph globals; both overridden by
 * the block's own textColor/textAlign. Intra-block node margins are zeroed —
 * vertical rhythm comes from block padding (text-block-model doctrine:
 * spacing is block-level, the doc is content-only).
 */
export function TextBlockView({ block, resolvedStyles }: TextBlockViewProps) {
  // Per-node alignment: a node's own attrs.textAlign (the only node-level
  // style attribute) beats the resolved block/global alignment.
  const nodeStyle = (styles: ResolvedTextNodeStyles, nodeTextAlign?: TextAlign) => ({
    fontFamily: styles.fontFamily,
    color: styles.textColor,
    textAlign: nodeTextAlign ?? styles.textAlign,
    // Unbroken runs (long words, pasted tokens) must wrap inside the block
    // instead of overflowing its edges. `wordWrap` is the email-safe classic
    // (browsers alias it to overflow-wrap, so the canvas is covered too);
    // `wordBreak` widens coverage across email clients.
    wordWrap: "break-word" as const,
    wordBreak: "break-word" as const,
  });

  return (
    <Row>
      <Column style={blockPaddingStyle(resolvedStyles)}>
        {block.properties.text.content.map((node, index) => {
          if (node.type === "heading") {
            const { level } = node.attrs;
            return (
              <Heading
                key={index}
                as={`h${level}`}
                style={{
                  ...nodeStyle(resolvedStyles[`heading${level}`], node.attrs.textAlign),
                  fontSize: HEADING_FONT_SIZES[level],
                  lineHeight: "1.3",
                  fontWeight: "bold",
                  margin: 0,
                }}
              >
                {renderInlineNodes(node.content, resolvedStyles.linkTextColor)}
              </Heading>
            );
          }
          return (
            <Text
              key={index}
              style={{
                ...nodeStyle(resolvedStyles.paragraph, node.attrs?.textAlign),
                marginTop: 0,
                marginBottom: 0,
              }}
            >
              {renderInlineNodes(node.content, resolvedStyles.linkTextColor)}
            </Text>
          );
        })}
      </Column>
    </Row>
  );
}
