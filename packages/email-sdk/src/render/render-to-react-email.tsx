import type { ReactElement } from "react";
import { Body, Head, Html } from "react-email";
import type { EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { inflate, type EmailTreeNode } from "../store/tree";
import type { GlobalStyles } from "../schema/globals";
import { DocumentIntegrityError } from "./errors";
import { resolveBlockStyles } from "./styles";
import { SectionBlockView } from "./blocks/SectionBlockView";
import { RowBlockView } from "./blocks/RowBlockView";
import { ColumnBlockView } from "./blocks/ColumnBlockView";
import { TextBlockView } from "./blocks/TextBlockView";
import { ButtonBlockView } from "./blocks/ButtonBlockView";
import { ImageBlockView } from "./blocks/ImageBlockView";
import { DividerBlockView } from "./blocks/DividerBlockView";

/**
 * Recursive traversal of the inflated tree: each block type renders through
 * its wrapper view with styles resolved from
 * DEFAULT_GLOBAL_STYLES → root.properties.globals → block overrides.
 */
function renderTreeNode(node: EmailTreeNode, globals: GlobalStyles | undefined): ReactElement {
  const { block } = node;
  const children = node.children.map((child) => renderTreeNode(child, globals));

  switch (block.type) {
    case "section":
      return (
        <SectionBlockView
          key={block.id}
          block={block}
          resolvedStyles={resolveBlockStyles(globals, block)}
        >
          {children}
        </SectionBlockView>
      );
    case "row":
      return (
        <RowBlockView
          key={block.id}
          block={block}
          resolvedStyles={resolveBlockStyles(globals, block)}
        >
          {children}
        </RowBlockView>
      );
    case "column":
      return (
        <ColumnBlockView
          key={block.id}
          block={block}
          resolvedStyles={resolveBlockStyles(globals, block)}
        >
          {children}
        </ColumnBlockView>
      );
    case "text":
      return (
        <TextBlockView key={block.id} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "button":
      return (
        <ButtonBlockView key={block.id} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "image":
      return (
        <ImageBlockView key={block.id} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "divider":
      return (
        <DividerBlockView key={block.id} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "root":
      throw new Error(
        `renderTreeNode: unexpected nested root block "${block.id}" — the root is rendered by renderToReactEmail`,
      );
  }
}

/**
 * Render a flat email document to a React Email element tree.
 *
 * Validates referential integrity first and throws DocumentIntegrityError
 * (with the structured error list) on failure, then inflates and traverses:
 * root → Html/Head/Body (emailBackgroundColor) → per-section full-width band
 * + centered Container (contentWidth) → rows/columns/leaves.
 */
export function renderToReactEmail(document: EmailDocument): ReactElement {
  const integrity = checkDocumentIntegrity(document);
  if (!integrity.isValid) {
    throw new DocumentIntegrityError(integrity.errors);
  }

  const tree = inflate(document);
  const globals = tree.block.properties.globals;
  const rootStyles = resolveBlockStyles(globals, tree.block);

  return (
    <Html lang="en">
      <Head />
      <Body style={{ backgroundColor: rootStyles.emailBackgroundColor, margin: 0, padding: 0 }}>
        {tree.children.map((child) => renderTreeNode(child, globals))}
      </Body>
    </Html>
  );
}
