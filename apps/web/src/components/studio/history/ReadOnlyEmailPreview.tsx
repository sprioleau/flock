"use client";

import { useMemo } from "react";
import {
  ButtonBlockView,
  ColumnBlockView,
  DividerBlockView,
  ImageBlockView,
  inflate,
  resolveBlockStyles,
  resolveRootBlockStyles,
  RowBlockView,
  SectionBlockView,
  TextBlockView,
  type EmailDocument,
  type EmailTreeNode,
  type GlobalStyles,
} from "@tandem/email-sdk";

/**
 * A historical document rendered through the SAME SDK block views the canvas
 * uses (visual parity), but with NO interactive shells: no selection, no
 * drag, no inline editing, no add-block affordances. `pointer-events-none`
 * on the surface guarantees nothing inside is clickable. The whole email is
 * laid out at its natural width and scaled down via CSS `zoom` (which,
 * unlike `transform: scale`, keeps layout height in sync) to fit the
 * history drawer.
 */

/** Natural layout width the preview is composed at before scaling. */
const PREVIEW_LAYOUT_WIDTH_PX = 640;

/** How far the preview is scaled down to fit the drawer. */
const PREVIEW_ZOOM = 0.62;

function ReadOnlyNode({ node, globals }: { node: EmailTreeNode; globals: GlobalStyles | undefined }) {
  const { block } = node;
  const children = node.children.map((child) => (
    <ReadOnlyNode key={child.block.id} node={child} globals={globals} />
  ));

  switch (block.type) {
    case "section":
      return (
        <SectionBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          {children}
        </SectionBlockView>
      );
    case "row":
      return (
        <RowBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          {children}
        </RowBlockView>
      );
    case "column":
      return (
        <ColumnBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          {children}
        </ColumnBlockView>
      );
    case "text":
      return <TextBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "button":
      return <ButtonBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "image":
      return <ImageBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "divider":
      return <DividerBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "root":
      // The root surface is rendered by ReadOnlyEmailPreview itself.
      return null;
  }
}

export function ReadOnlyEmailPreview({ doc }: { doc: EmailDocument }) {
  const tree = useMemo(() => inflate(doc), [doc]);
  const rootStyles = resolveRootBlockStyles(tree.block);
  const globals = tree.block.properties.globals;

  return (
    <div className="overflow-x-hidden rounded-md border" data-testid="history-version-preview">
      <div
        className="pointer-events-none select-none"
        style={{
          width: PREVIEW_LAYOUT_WIDTH_PX,
          zoom: PREVIEW_ZOOM,
          backgroundColor: rootStyles.emailBackgroundColor,
        }}
      >
        {tree.children.map((child) => (
          <ReadOnlyNode key={child.block.id} node={child} globals={globals} />
        ))}
      </div>
    </div>
  );
}
