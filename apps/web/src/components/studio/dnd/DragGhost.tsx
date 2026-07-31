"use client";

import {
  ButtonBlockView,
  CodeBlockView,
  DividerBlockView,
  ImageBlockView,
  LinkBlockView,
  resolveBlockStyles,
  SpacerBlockView,
  TextBlockView,
  type BlockId,
  type EmailDocument,
  type GlobalStyles,
} from "@tandem/email-sdk";

export interface DragGhostProps {
  blockId: BlockId;
  doc: EmailDocument;
  globals: GlobalStyles | undefined;
}

/**
 * Static render of the dragged block for the DragOverlay — the same SDK
 * views the canvas uses, minus the interactive shell, so the lifted copy
 * matches what the user picked up. Only leaf blocks are draggable;
 * containers render nothing.
 */
export function DragGhost({ blockId, doc, globals }: DragGhostProps) {
  const block = doc[blockId];
  if (block === undefined) {
    return null;
  }
  switch (block.type) {
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
