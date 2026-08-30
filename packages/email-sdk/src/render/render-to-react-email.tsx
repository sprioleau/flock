import type { ReactElement } from "react";
import { Body, Head, Html, Preview } from "react-email";
import type { EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { inflate, type EmailTreeNode } from "../store/tree";
import type { GlobalStyles } from "../schema/globals";
import { DocumentIntegrityError } from "./errors";
import { resolveBlockStyles } from "./styles";
import { buildBlockAnnotation } from "./blocks/shared";
import { SectionBlockView } from "./blocks/SectionBlockView";
import { RowBlockView } from "./blocks/RowBlockView";
import { ColumnBlockView } from "./blocks/ColumnBlockView";
import { TextBlockView } from "./blocks/TextBlockView";
import { ButtonBlockView } from "./blocks/ButtonBlockView";
import { ImageBlockView } from "./blocks/ImageBlockView";
import { DividerBlockView } from "./blocks/DividerBlockView";
import { LinkBlockView } from "./blocks/LinkBlockView";
import { CodeBlockView } from "./blocks/CodeBlockView";
import { SpacerBlockView } from "./blocks/SpacerBlockView";

/**
 * Recursive traversal of the inflated tree: each block type renders through
 * its wrapper view with styles resolved from
 * DEFAULT_GLOBAL_STYLES → root.properties.globals → block overrides.
 */
interface RenderTreeNodeOptions {
  node: EmailTreeNode;
  globals: GlobalStyles | undefined;
  /* Stamp each block's outermost element with its id — analysis renders only. */
  isBlockAnnotated: boolean;
}

function renderTreeNode({ node, globals, isBlockAnnotated }: RenderTreeNodeOptions): ReactElement {
  const { block } = node;
  const children = node.children.map((child) =>
    renderTreeNode({ node: child, globals, isBlockAnnotated }),
  );
  /*
    Off by default, so the email a subscriber receives is unchanged. On, this
    stamps every block's outermost element with its id — the correspondence
    the pre-send compatibility check needs to turn an HTML-level finding into
    a block-level one. See BLOCK_ANNOTATION_ATTRIBUTE in ./blocks/shared.
  */
  const annotation = buildBlockAnnotation(isBlockAnnotated ? block.id : undefined);

  switch (block.type) {
    case "section":
      return (
        <SectionBlockView
          key={block.id}
          annotation={annotation}
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
          annotation={annotation}
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
          annotation={annotation}
          block={block}
          resolvedStyles={resolveBlockStyles(globals, block)}
        >
          {children}
        </ColumnBlockView>
      );
    case "text":
      return (
        <TextBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "button":
      return (
        <ButtonBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "image":
      return (
        <ImageBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "divider":
      return (
        <DividerBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "link":
      return (
        <LinkBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "code":
      return (
        <CodeBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
      );
    case "spacer":
      return (
        <SpacerBlockView key={block.id} annotation={annotation} block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
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
export interface RenderToReactEmailOptions {
  /**
   * Stamp every block's outermost element with `data-flock-block-id`.
   *
   * ANALYSIS ONLY. The pre-send compatibility check renders a second,
   * throwaway copy of the email with this on so it can trace a finding about
   * a `<td>` back to the block that produced it; the render that becomes the
   * message never sets it, and so never carries the attribute. Default false.
   */
  isBlockAnnotated?: boolean;
  /**
   * The email's subject line, also emitted as the document `<title>` inside
   * `<Head>` — a `<title>` is an accessibility requirement React Email leaves
   * to the caller.
   *
   * Rendered only when present and non-empty after trimming; an absent, empty,
   * or whitespace-only value leaves `<Head>` exactly as it is by default (the
   * two React Email meta tags, no `<title>`), keeping the output byte-identical
   * to a render that never knew about a subject.
   */
  subject?: string;
  /**
   * Preheader text — the preview a client shows next to the subject in the
   * inbox list, rendered through React Email's `<Preview>`.
   *
   * Rendered only when present and non-empty after trimming. `<Preview>` is not
   * free: it stamps a hidden preheader div plus a run of padding characters
   * into the body, so an absent, empty, or whitespace-only value emits no
   * `<Preview>` at all, leaving today's output byte-identical.
   *
   * `<Preview>` defaults to also emitting its own `<title>`; that is switched
   * off here (`useTitleTag={false}`) so {@link subject} stays the single source
   * of the document title and the two can be set together without producing a
   * duplicate `<title>`.
   */
  previewText?: string;
}

export function renderToReactEmail(
  document: EmailDocument,
  options: RenderToReactEmailOptions = {},
): ReactElement {
  const integrity = checkDocumentIntegrity(document);
  if (!integrity.isValid) {
    throw new DocumentIntegrityError(integrity.errors);
  }

  const tree = inflate(document);
  const globals = tree.block.properties.globals;
  const rootStyles = resolveBlockStyles(globals, tree.block);

  const subject = options.subject?.trim();
  const previewText = options.previewText?.trim();

  return (
    <Html lang="en">
      <Head>{subject ? <title>{subject}</title> : null}</Head>
      {previewText ? <Preview useTitleTag={false}>{previewText}</Preview> : null}
      <Body style={{ backgroundColor: rootStyles.emailBackgroundColor, margin: 0, padding: 0 }}>
        {tree.children.map((child) =>
          renderTreeNode({
            node: child,
            globals,
            isBlockAnnotated: options.isBlockAnnotated ?? false,
          }),
        )}
      </Body>
    </Html>
  );
}
