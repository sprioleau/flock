"use client";

import {
  ButtonBlockView,
  CodeBlockView,
  ColumnBlockView,
  DividerBlockView,
  ImageBlockView,
  LinkBlockView,
  resolveBlockStyles,
  RowBlockView,
  SectionBlockView,
  SpacerBlockView,
  TextBlockView,
  type BlockId,
  type EmailDocument,
  type GlobalStyles,
} from "@flock/email-sdk";

export interface DragGhostProps {
  blockId: BlockId;
  doc: EmailDocument;
  globals: GlobalStyles | undefined;
}

/**
 * Static render of the dragged block for the DragOverlay — the same SDK
 * views the canvas uses, minus the interactive shell, so the lifted copy
 * matches what the user picked up. Leaves render alone; a dragged section
 * renders its whole subtree (rows/columns/leaves recurse). The root is never
 * a drag source and renders nothing.
 */
export function DragGhost({ blockId, doc, globals }: DragGhostProps) {
  const block = doc[blockId];
  if (block === undefined) {
    return null;
  }
  const children =
    "childrenIds" in block
      ? block.childrenIds.map((childId) => (
          <DragGhost key={childId} blockId={childId} doc={doc} globals={globals} />
        ))
      : null;
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
    case "link":
      return <LinkBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "code":
      return <CodeBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "spacer":
      return <SpacerBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    default:
      return null;
  }
}
